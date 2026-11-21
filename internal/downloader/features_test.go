package downloader

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type taggedRoundTripper struct {
	base http.RoundTripper
	tag  string
}

func (rt taggedRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	cp := req.Clone(req.Context())
	cp.Header.Set("X-Test-Route", rt.tag)
	return rt.base.RoundTrip(cp)
}

// Exercises the exact segment routing and retry path without claiming two
// physical Internet subscriptions exist in a CI virtual machine.
func TestSegmentsAcrossTwoIndependentClients(t *testing.T) {
	var mu sync.Mutex
	hits := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tag := r.Header.Get("X-Test-Route")
		mu.Lock()
		hits[tag]++
		mu.Unlock()
		// Deliberately fail one link once so the segment retries on the other.
		if tag == "A" && strings.HasPrefix(r.Header.Get("Range"), "bytes=0-") {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		trimmed := strings.TrimPrefix(r.Header.Get("Range"), "bytes=")
		var a, b int64
		if _, err := fmt.Sscanf(trimmed, "%d-%d", &a, &b); err != nil {
			t.Errorf("unexpected range %q", trimmed)
			return
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", a, b, len(blob)))
		w.Header().Set("Content-Length", fmt.Sprint(b-a+1))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(blob[a : b+1])
	}))
	defer srv.Close()
	directory := t.TempDir()
	engine := New(filepath.Join(directory, "state.json"), directory)
	job := &Job{ID: "multi-route", URL: srv.URL, Directory: directory, FileName: "out.bin", Target: filepath.Join(directory, "out.bin"), Total: func() *int64 { n := int64(len(blob)); return &n }(), Validator: "", Status: "downloading"}
	routes := []*http.Client{
		{Transport: taggedRoundTripper{base: http.DefaultTransport, tag: "A"}},
		{Transport: taggedRoundTripper{base: http.DefaultTransport, tag: "B"}},
	}
	const pieces = 4
	job.Parts = make([]Part, pieces)
	var wg sync.WaitGroup
	errs := make(chan error, pieces)
	for i := range job.Parts {
		job.Parts[i] = Part{Start: int64(len(blob)) * int64(i) / pieces, End: int64(len(blob))*int64(i+1)/pieces - 1}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs <- engine.fetchPart(context.Background(), job, i, job.Parts[i], 0, true, routes, 2)
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := engine.assemble(job); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(job.Target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, blob) {
		t.Fatal("routed download corrupted data")
	}
	mu.Lock()
	defer mu.Unlock()
	if hits["A"] == 0 || hits["B"] == 0 {
		t.Fatalf("both clients must transfer bytes, hits=%v", hits)
	}
	t.Logf("tested route round-robin and retry: %v", hits)
}

func TestSettingsFolderRoutingAndPersistence(t *testing.T) {
	srv, _ := fixture(t, false)
	root := t.TempDir()
	e := newEngine(t, root)
	defaultDir := filepath.Join(root, "downloads")
	installers := filepath.Join(root, "installers")
	settings := Settings{Concurrency: 2, Segments: 8, DownloadDirectory: defaultDir, ProgramsDirectory: installers, SeparatePrograms: true, NetworkMode: "system", Retries: 4, AutoPaste: false}
	if err := e.UpdateSettings(settings); err != nil {
		t.Fatal(err)
	}
	id, err := e.Add(AddRequest{URL: srv.URL + "/installer.exe"})
	if err != nil {
		t.Fatal(err)
	}
	job := await(t, e, id)
	if job.Directory != installers || job.Connections != 8 {
		t.Fatalf("not using saved defaults: %+v", job)
	}
	checkFile(t, job)
	id, err = e.Add(AddRequest{URL: srv.URL + "/notes.txt"})
	if err != nil {
		t.Fatal(err)
	}
	job = await(t, e, id)
	if job.Directory != defaultDir {
		t.Fatalf("regular file routed incorrectly: %s", job.Directory)
	}
	checkFile(t, job)
	if err := e.Close(); err != nil {
		t.Fatal(err)
	}
	restored := New(filepath.Join(root, "state.json"), root)
	if err := restored.Init(); err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	got := restored.Snapshot().Settings
	if got.Segments != 8 || got.Retries != 4 || got.AutoPaste || got.ProgramsDirectory != installers || !got.SeparatePrograms {
		t.Fatalf("settings did not persist: %+v", got)
	}
}

func TestSettingsValidationAndNetworkAdapters(t *testing.T) {
	e := newEngine(t, t.TempDir())
	invalid := e.Snapshot().Settings
	invalid.NetworkMode = "not-a-mode"
	if err := e.UpdateSettings(invalid); err == nil {
		t.Fatal("invalid network mode allowed")
	}
	invalid.NetworkMode = "system"
	invalid.ProxyURL = "file:///etc/passwd"
	if err := e.UpdateSettings(invalid); err == nil {
		t.Fatal("unsafe proxy allowed")
	}
	invalid.ProxyURL = "socks5://127.0.0.1:1080"
	if err := e.UpdateSettings(invalid); err != nil {
		t.Fatal(err)
	}
	got := AvailableLinks()
	for _, iface := range got {
		if iface.ID == "" || iface.Address == "" || iface.Index <= 0 {
			t.Fatalf("bad adapter: %+v", iface)
		}
	}
	settings := e.Snapshot().Settings
	settings.NetworkMode = "combine"
	settings.Interfaces = []string{"definitely-not-an-active-adapter"}
	if _, _, err := e.clientsFor(settings); err == nil {
		t.Fatal("missing requested interface must fail rather than silently use default")
	}
	// Ensure the selected routes do not automatically escape to the default network.
	if len(got) > 0 {
		settings.Interfaces = []string{got[0].ID}
		routes, done, err := e.clientsFor(settings)
		if err != nil {
			t.Fatal(err)
		}
		defer done()
		if len(routes) != 1 {
			t.Fatal("expected single chosen adapter")
		}
	}
}
