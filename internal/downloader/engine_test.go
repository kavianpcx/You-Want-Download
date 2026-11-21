package downloader

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

var blob = func() []byte {
	b := make([]byte, 3_000_113)
	for i := range b {
		b[i] = byte(i % 251)
	}
	return b
}()

func fixture(t *testing.T, slow bool) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	counter := new(atomic.Int32)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/404") {
			w.WriteHeader(404)
			return
		}
		useRange := !strings.HasPrefix(r.URL.Path, "/no-range")
		w.Header().Set("ETag", "\"v1\"")
		w.Header().Set("Content-Type", "application/octet-stream")
		data := blob
		code := http.StatusOK
		if useRange {
			w.Header().Set("Accept-Ranges", "bytes")
		}
		if useRange && strings.HasPrefix(r.Header.Get("Range"), "bytes=") {
			var start, end int64
			end = int64(len(blob) - 1)
			trimmed := strings.TrimPrefix(r.Header.Get("Range"), "bytes=")
			split := strings.SplitN(trimmed, "-", 2)
			a, err := strconv.ParseInt(split[0], 10, 64)
			if err == nil {
				start = a
			}
			if len(split) > 1 && split[1] != "" {
				end, _ = strconv.ParseInt(split[1], 10, 64)
			}
			if start > int64(len(blob)-1) || end >= int64(len(blob)) {
				w.WriteHeader(416)
				return
			}
			if strings.HasPrefix(r.URL.Path, "/bad-range") {
				w.Header().Set("Content-Range", "bytes 9-10/100")
			} else {
				w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(blob)))
			}
			data = blob[start : end+1]
			code = http.StatusPartialContent
			if len(data) > 1 {
				counter.Add(1)
			}
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(code)
		if slow && len(data) > 1 {
			for at := 0; at < len(data); at += 16384 {
				end := at + 16384
				if end > len(data) {
					end = len(data)
				}
				if _, err := w.Write(data[at:end]); err != nil {
					return
				}
				if f, ok := w.(http.Flusher); ok {
					f.Flush()
				}
				time.Sleep(3 * time.Millisecond)
			}
		} else {
			w.Write(data)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, counter
}
func newEngine(t *testing.T, dir string) *Engine {
	t.Helper()
	e := New(filepath.Join(dir, "state.json"), dir)
	if err := e.Init(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.Close() })
	return e
}
func await(t *testing.T, e *Engine, id string) *Job {
	t.Helper()
	until := time.Now().Add(15 * time.Second)
	for time.Now().Before(until) {
		j, err := e.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		if j.Status == "completed" {
			return j
		}
		if j.Status == "error" {
			t.Fatalf("unexpected failure: %s", j.Error)
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatal("download timed out")
	return nil
}
func checkFile(t *testing.T, j *Job) {
	t.Helper()
	data, err := os.ReadFile(j.Target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, blob) {
		t.Fatalf("file contents differ (%d bytes)", len(data))
	}
}
func TestSegmentedExactData(t *testing.T) {
	srv, counter := fixture(t, false)
	dir := t.TempDir()
	e := newEngine(t, dir)
	id, err := e.Add(AddRequest{URL: srv.URL + "/file.zip", Connections: 8})
	if err != nil {
		t.Fatal(err)
	}
	j := await(t, e, id)
	checkFile(t, j)
	if counter.Load() < 2 {
		t.Fatalf("expected multipart; requests=%d", counter.Load())
	}
	if len(j.Parts) < 2 || len(j.Parts) > 8 {
		t.Fatalf("expected 2–8 safe segments, got %d", len(j.Parts))
	}
	names, _ := filepath.Glob(filepath.Join(dir, "*.part"))
	if len(names) != 0 {
		t.Fatal("partial data was not removed")
	}
}
func TestSingleConnectionOverride(t *testing.T) {
	srv, counter := fixture(t, false)
	e := newEngine(t, t.TempDir())
	id, err := e.Add(AddRequest{URL: srv.URL + "/data", Connections: 1})
	if err != nil {
		t.Fatal(err)
	}
	j := await(t, e, id)
	checkFile(t, j)
	if len(j.Parts) != 1 || counter.Load() != 1 {
		t.Fatalf("expected one connection; parts=%d, ranges=%d", len(j.Parts), counter.Load())
	}
}
func TestRangeUnsupportedFallback(t *testing.T) {
	srv, counter := fixture(t, false)
	e := newEngine(t, t.TempDir())
	id, err := e.Add(AddRequest{URL: srv.URL + "/no-range", Connections: 16})
	if err != nil {
		t.Fatal(err)
	}
	j := await(t, e, id)
	checkFile(t, j)
	if len(j.Parts) != 1 || counter.Load() != 0 {
		t.Fatalf("expected single stream, parts=%d", len(j.Parts))
	}
}
func TestPauseRestartResume(t *testing.T) {
	srv, _ := fixture(t, true)
	dir := t.TempDir()
	e := New(filepath.Join(dir, "state.json"), dir)
	if err := e.Init(); err != nil {
		t.Fatal(err)
	}
	id, err := e.Add(AddRequest{URL: srv.URL + "/slow", Connections: 1})
	if err != nil {
		t.Fatal(err)
	}
	until := time.Now().Add(5 * time.Second)
	for time.Now().Before(until) {
		j, _ := e.Get(id)
		if j.Downloaded > 90_000 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := e.Pause(id); err != nil {
		t.Fatal(err)
	}
	if err := e.Close(); err != nil {
		t.Fatal(err)
	}
	restored := New(filepath.Join(dir, "state.json"), dir)
	if err := restored.Init(); err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	j, _ := restored.Get(id)
	if j.Status != "paused" {
		t.Fatalf("status=%s", j.Status)
	}
	if err := restored.Resume(id); err != nil {
		t.Fatal(err)
	}
	checkFile(t, await(t, restored, id))
}
func TestInvalidHTTPStatus(t *testing.T) {
	srv, _ := fixture(t, false)
	e := newEngine(t, t.TempDir())
	id, err := e.Add(AddRequest{URL: srv.URL + "/404"})
	if err != nil {
		t.Fatal(err)
	}
	until := time.Now().Add(5 * time.Second)
	for time.Now().Before(until) {
		j, _ := e.Get(id)
		if j.Status == "error" {
			if !strings.Contains(j.Error, "404") {
				t.Fatal(j.Error)
			}
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatal("404 never surfaced")
}
func TestRejectCorruptRangeAndUnsafeURL(t *testing.T) {
	srv, _ := fixture(t, false)
	e := newEngine(t, t.TempDir())
	for _, raw := range []string{"file:///etc/passwd", "javascript:alert(1)", "ftp://server/file"} {
		if _, err := e.Add(AddRequest{URL: raw}); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	id, err := e.Add(AddRequest{URL: srv.URL + "/bad-range"})
	if err != nil {
		t.Fatal(err)
	}
	until := time.Now().Add(5 * time.Second)
	for time.Now().Before(until) {
		j, _ := e.Get(id)
		if j.Status == "error" {
			if _, err := os.Stat(j.Target); !os.IsNotExist(err) {
				t.Fatal("unexpected finalized file")
			}
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatal("bad-range never rejected")
}
func TestPerDownloadSettingsAndNoOverwrite(t *testing.T) {
	srv, _ := fixture(t, false)
	dir := t.TempDir()
	e := newEngine(t, dir)
	if err := e.UpdateSettings(Settings{Concurrency: 2, Segments: 16}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "data.zip"), []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	id, err := e.Add(AddRequest{URL: srv.URL + "/file", FileName: "data.zip", ScheduledAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
	if err != nil {
		t.Fatal(err)
	}
	j, _ := e.Get(id)
	if j.Connections != 16 || j.FileName != "data (1).zip" {
		t.Fatalf("override and naming broken: %+v", j)
	}
	if err := e.SetConnections(id, 2); err != nil {
		t.Fatal(err)
	}
	if err := e.Resume(id); err != nil {
		t.Fatal(err)
	}
	checkFile(t, await(t, e, id))
	b, err := os.ReadFile(filepath.Join(dir, "data.zip"))
	if err != nil || !bytes.Equal(b, []byte("untouched")) {
		t.Fatal("original user file overwritten")
	}
}
func TestRemoveNeverDeletesCompletedFile(t *testing.T) {
	srv, _ := fixture(t, false)
	e := newEngine(t, t.TempDir())
	id, _ := e.Add(AddRequest{URL: srv.URL + "/file"})
	j := await(t, e, id)
	if err := e.Remove(id); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(j.Target)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := io.Copy(io.Discard, f); err != nil {
		t.Fatal(err)
	}
}
