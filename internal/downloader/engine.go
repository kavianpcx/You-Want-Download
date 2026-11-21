// Package downloader implements resumable, segmented HTTP(S) downloads without a GUI dependency.
package downloader

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const MinPartSize int64 = 512 * 1024
const MaxConnections = 16

var rangePattern = regexp.MustCompile(`^bytes\s+(\d+)-(\d+)/(\d+|\*)$`)
var invalidName = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]`)
var deviceName = regexp.MustCompile(`(?i)^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$`)

type Settings struct {
	Concurrency int `json:"concurrency"`
	Segments    int `json:"segments"`
}
type Part struct {
	Start int64 `json:"start"`
	End   int64 `json:"end"`
}
type Job struct {
	ID          string `json:"id"`
	URL         string `json:"url"`
	FileName    string `json:"fileName"`
	Directory   string `json:"directory"`
	Target      string `json:"target"`
	Status      string `json:"status"`
	CreatedAt   string `json:"createdAt"`
	ScheduledAt string `json:"scheduledAt,omitempty"`
	Total       *int64 `json:"total"`
	Downloaded  int64  `json:"downloaded"`
	Speed       int64  `json:"speed"`
	Error       string `json:"error,omitempty"`
	Validator   string `json:"validator,omitempty"`
	Connections int    `json:"connections"`
	Parts       []Part `json:"parts,omitempty"`
}
type Snapshot struct {
	Items    []*Job   `json:"items"`
	Settings Settings `json:"settings"`
}
type AddRequest struct {
	URL         string `json:"url"`
	FileName    string `json:"fileName"`
	Directory   string `json:"directory"`
	ScheduledAt string `json:"scheduledAt"`
	Connections int    `json:"connections"`
}
type Engine struct {
	mu          sync.Mutex
	saveMu      sync.Mutex
	jobs        []*Job
	settings    Settings
	stateFile   string
	downloadDir string
	active      map[string]context.CancelFunc
	signal      chan struct{}
	done        chan struct{}
	wg          sync.WaitGroup
	onChange    func()
	lastEvent   atomic.Int64
	client      *http.Client
	closed      bool
}

func New(stateFile, downloadDir string) *Engine {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	transport.MaxIdleConnsPerHost = 20
	transport.ResponseHeaderTimeout = 25 * time.Second
	return &Engine{stateFile: stateFile, downloadDir: downloadDir, settings: Settings{Concurrency: 3, Segments: 4},
		active: map[string]context.CancelFunc{}, signal: make(chan struct{}, 1), done: make(chan struct{}),
		client: &http.Client{Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 8 || (req.URL.Scheme != "http" && req.URL.Scheme != "https") {
				return errors.New("unsafe or excessive HTTP redirect")
			}
			return nil
		}},
	}
}
func (e *Engine) SetOnChange(fn func()) { e.mu.Lock(); e.onChange = fn; e.mu.Unlock() }
func (e *Engine) broadcast() {
	e.mu.Lock()
	fn := e.onChange
	e.mu.Unlock()
	if fn != nil {
		fn()
	}
}
func (e *Engine) progressEvent() {
	now := time.Now().UnixMilli()
	prev := e.lastEvent.Load()
	if now-prev > 250 && e.lastEvent.CompareAndSwap(prev, now) {
		e.broadcast()
	}
}
func (e *Engine) kick() {
	select {
	case e.signal <- struct{}{}:
	default:
	}
}
func (e *Engine) Init() error {
	if err := os.MkdirAll(e.downloadDir, 0755); err != nil {
		return err
	}
	raw, err := os.ReadFile(e.stateFile)
	if err == nil {
		var stored Snapshot
		if err := json.Unmarshal(raw, &stored); err != nil {
			return fmt.Errorf("invalid saved downloads: %w", err)
		}
		e.mu.Lock()
		if stored.Settings.Concurrency >= 1 && stored.Settings.Concurrency <= 8 {
			e.settings.Concurrency = stored.Settings.Concurrency
		}
		if stored.Settings.Segments >= 1 && stored.Settings.Segments <= MaxConnections {
			e.settings.Segments = stored.Settings.Segments
		}
		for _, j := range stored.Items {
			if j == nil {
				continue
			}
			if j.Status == "downloading" {
				j.Status = "queued"
			}
			j.Speed = 0
			e.jobs = append(e.jobs, j)
		}
		e.mu.Unlock()
	} else if !os.IsNotExist(err) {
		return err
	}
	e.wg.Add(1)
	go e.loop()
	e.kick()
	return nil
}
func (e *Engine) loop() {
	defer e.wg.Done()
	tick := time.NewTicker(350 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-e.done:
			return
		case <-tick.C:
			e.pump()
		case <-e.signal:
			e.pump()
		}
	}
}
func (e *Engine) snapshotLocked() Snapshot {
	s := Snapshot{Items: make([]*Job, 0, len(e.jobs)), Settings: e.settings}
	for _, j := range e.jobs {
		cp := *j
		if j.Total != nil {
			x := *j.Total
			cp.Total = &x
		}
		cp.Parts = append([]Part(nil), j.Parts...)
		s.Items = append(s.Items, &cp)
	}
	return s
}
func (e *Engine) Snapshot() Snapshot { e.mu.Lock(); defer e.mu.Unlock(); return e.snapshotLocked() }
func (e *Engine) save() error {
	e.saveMu.Lock()
	defer e.saveMu.Unlock()
	e.mu.Lock()
	raw, err := json.MarshalIndent(e.snapshotLocked(), "", "  ")
	e.mu.Unlock()
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(e.stateFile), 0700); err != nil {
		return err
	}
	tmp := e.stateFile + ".tmp"
	if err = os.WriteFile(tmp, raw, 0600); err != nil {
		return err
	}
	if err = os.Rename(tmp, e.stateFile); err != nil {
		return err
	}
	return nil
}
func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func cleanName(s string) string {
	s = invalidName.ReplaceAllString(strings.TrimSpace(s), "_")
	s = strings.TrimRight(s, ". ")
	if len(s) > 170 {
		s = s[:170]
	}
	if s == "" || s == "." || s == ".." {
		s = "download"
	}
	if deviceName.MatchString(s) {
		s = "_" + s
	}
	return s
}
func validateURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("only HTTP and HTTPS links are supported")
	}
	if u.Host == "" || u.User != nil {
		return "", errors.New("invalid URL")
	}
	return u.String(), nil
}
func nameFromURL(raw string) string {
	u, _ := url.Parse(raw)
	s, err := url.PathUnescape(strings.TrimSuffix(u.Path, "/"))
	if err != nil {
		return "download"
	}
	return cleanName(filepath.Base(s))
}
func (e *Engine) uniqueTargetLocked(dir, name string) (string, error) {
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 0; i < 10000; i++ {
		candidate := filepath.Join(dir, name)
		if i > 0 {
			candidate = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, i, ext))
		}
		found := false
		for _, j := range e.jobs {
			if strings.EqualFold(candidate, j.Target) {
				found = true
				break
			}
		}
		if found {
			continue
		}
		_, err := os.Stat(candidate)
		if os.IsNotExist(err) {
			return candidate, nil
		}
		if err != nil {
			return "", err
		}
	}
	return "", errors.New("destination filename exhausted")
}
func (e *Engine) Add(arg AddRequest) (string, error) {
	link, err := validateURL(arg.URL)
	if err != nil {
		return "", err
	}
	dir := arg.Directory
	if dir == "" {
		dir = e.downloadDir
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	if err = os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	name := arg.FileName
	if strings.TrimSpace(name) == "" {
		name = nameFromURL(link)
	}
	name = cleanName(name)
	var scheduled string
	if arg.ScheduledAt != "" {
		t, err := time.Parse(time.RFC3339, arg.ScheduledAt)
		if err != nil {
			return "", errors.New("invalid schedule; ISO8601 timestamp required")
		}
		scheduled = t.UTC().Format(time.RFC3339)
	}
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return "", errors.New("download manager is shutting down")
	}
	target, err := e.uniqueTargetLocked(dir, name)
	if err != nil {
		e.mu.Unlock()
		return "", err
	}
	count := arg.Connections
	if count == 0 {
		count = e.settings.Segments
	}
	if count < 1 || count > MaxConnections {
		e.mu.Unlock()
		return "", errors.New("connections must be 1–16")
	}
	j := &Job{ID: newID(), URL: link, FileName: filepath.Base(target), Directory: dir, Target: target, Status: "queued", CreatedAt: time.Now().UTC().Format(time.RFC3339), ScheduledAt: scheduled, Connections: count}
	e.jobs = append([]*Job{j}, e.jobs...)
	e.mu.Unlock()
	if err = e.save(); err != nil {
		return "", err
	}
	e.broadcast()
	e.kick()
	return j.ID, nil
}
func (e *Engine) findLocked(id string) (*Job, error) {
	for _, j := range e.jobs {
		if j.ID == id {
			return j, nil
		}
	}
	return nil, errors.New("download not found")
}
func (e *Engine) Pause(id string) error {
	e.mu.Lock()
	j, err := e.findLocked(id)
	if err == nil && j.Status != "completed" {
		j.Status = "paused"
		j.Speed = 0
		if cancel := e.active[id]; cancel != nil {
			cancel()
		}
	}
	e.mu.Unlock()
	if err != nil {
		return err
	}
	if err = e.save(); err != nil {
		return err
	}
	e.broadcast()
	return nil
}
func (e *Engine) Resume(id string) error {
	e.mu.Lock()
	j, err := e.findLocked(id)
	if err == nil && j.Status != "completed" {
		j.Status = "queued"
		j.Error = ""
		j.ScheduledAt = ""
	}
	e.mu.Unlock()
	if err != nil {
		return err
	}
	if err = e.save(); err != nil {
		return err
	}
	e.broadcast()
	e.kick()
	return nil
}
func (e *Engine) Remove(id string) error {
	e.mu.Lock()
	j, err := e.findLocked(id)
	if err == nil {
		if cancel := e.active[id]; cancel != nil {
			cancel()
		}
		for i, x := range e.jobs {
			if x == j {
				e.jobs = append(e.jobs[:i], e.jobs[i+1:]...)
				break
			}
		}
	}
	e.mu.Unlock()
	if err != nil {
		return err
	}
	if err = e.save(); err != nil {
		return err
	}
	e.broadcast()
	e.kick()
	return nil
}
func (e *Engine) UpdateSettings(s Settings) error {
	if s.Concurrency < 1 || s.Concurrency > 8 || s.Segments < 1 || s.Segments > MaxConnections {
		return errors.New("simultaneous downloads: 1–8; connections per file: 1–16")
	}
	e.mu.Lock()
	e.settings = s
	e.mu.Unlock()
	if err := e.save(); err != nil {
		return err
	}
	e.broadcast()
	e.kick()
	return nil
}
func (e *Engine) SetConnections(id string, count int) error {
	if count < 1 || count > MaxConnections {
		return errors.New("connections must be 1–16")
	}
	e.mu.Lock()
	j, err := e.findLocked(id)
	if err == nil {
		switch {
		case j.Status == "downloading":
			err = errors.New("pause the download before changing connections")
		case j.Status == "completed":
			err = errors.New("cannot edit completed downloads")
		case len(j.Parts) > 0 || j.Downloaded > 0:
			err = errors.New("this download has partial data; remove and re-add it to change connections")
		default:
			j.Connections = count
		}
	}
	e.mu.Unlock()
	if err != nil {
		return err
	}
	if err = e.save(); err != nil {
		return err
	}
	e.broadcast()
	return nil
}
func (e *Engine) pump() {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return
	}
	// Oldest queued jobs run first, just like an ordinary FIFO queue.
	for i := len(e.jobs) - 1; i >= 0 && len(e.active) < e.settings.Concurrency; i-- {
		j := e.jobs[i]
		if j.Status != "queued" {
			continue
		}
		if _, ok := e.active[j.ID]; ok {
			continue
		}
		if j.ScheduledAt != "" {
			t, err := time.Parse(time.RFC3339, j.ScheduledAt)
			if err == nil && t.After(time.Now()) {
				continue
			}
		}
		ctx, cancel := context.WithCancel(context.Background())
		e.active[j.ID] = cancel
		j.Status = "downloading"
		j.Error = ""
		e.wg.Add(1)
		go e.execute(ctx, j)
	}
	e.mu.Unlock()
	e.progressEvent()
}
func (e *Engine) execute(ctx context.Context, j *Job) {
	defer e.wg.Done()
	err := e.download(ctx, j)
	e.mu.Lock()
	delete(e.active, j.ID)
	attached := false
	for _, x := range e.jobs {
		if x == j {
			attached = true
			break
		}
	}
	if attached {
		if j.Status == "downloading" {
			if err == nil {
				j.Status = "completed"
				if j.Total != nil {
					j.Downloaded = *j.Total
				}
			} else if errors.Is(err, context.Canceled) {
				j.Status = "paused"
			} else {
				j.Status = "error"
				j.Error = err.Error()
			}
		}
		j.Speed = 0
	}
	e.mu.Unlock()
	_ = e.save()
	e.broadcast()
	e.kick()
}
func (e *Engine) clientRequest(ctx context.Context, method, raw string, headers http.Header) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, raw, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "YouWantDownload/0.2")
	req.Header.Set("Accept-Encoding", "identity")
	for k, values := range headers {
		for _, v := range values {
			req.Header.Add(k, v)
		}
	}
	return e.client.Do(req)
}
func parseContentRange(s string) (int64, int64, int64, bool) {
	m := rangePattern.FindStringSubmatch(s)
	if m == nil || m[3] == "*" {
		return 0, 0, 0, false
	}
	a, er1 := strconv.ParseInt(m[1], 10, 64)
	b, er2 := strconv.ParseInt(m[2], 10, 64)
	total, er3 := strconv.ParseInt(m[3], 10, 64)
	return a, b, total, er1 == nil && er2 == nil && er3 == nil && a <= b && b < total
}
func (e *Engine) probe(ctx context.Context, raw string) (size *int64, ranges bool, validator string, err error) {
	h := http.Header{}
	h.Set("Range", "bytes=0-0")
	res, err := e.clientRequest(ctx, http.MethodGet, raw, h)
	if err != nil {
		return nil, false, "", err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, false, "", fmt.Errorf("server returned HTTP %d", res.StatusCode)
	}
	if enc := res.Header.Get("Content-Encoding"); enc != "" && !strings.EqualFold(enc, "identity") {
		return nil, false, "", errors.New("compressed HTTP response cannot be downloaded safely")
	}
	validator = res.Header.Get("ETag")
	if validator == "" {
		validator = res.Header.Get("Last-Modified")
	}
	if res.StatusCode == 206 {
		start, end, total, valid := parseContentRange(res.Header.Get("Content-Range"))
		if !valid || start != 0 || end != 0 {
			return nil, false, "", errors.New("server returned invalid byte range")
		}
		return &total, true, validator, nil
	}
	if res.ContentLength >= 0 {
		n := res.ContentLength
		return &n, false, validator, nil
	}
	return nil, false, validator, nil
}
func (e *Engine) download(ctx context.Context, j *Job) error {
	size, ranges, validator, err := e.probe(ctx, j.URL)
	if err != nil {
		return err
	}
	e.mu.Lock()
	if (j.Total != nil && size != nil && *j.Total != *size) || (j.Validator != "" && j.Validator != validator) {
		e.mu.Unlock()
		return errors.New("remote file changed; remove and add the task again")
	}
	if size != nil {
		j.Total = size
	}
	j.Validator = validator
	if len(j.Parts) == 0 {
		count := 1
		if ranges && size != nil && *size >= MinPartSize {
			count = j.Connections
			if count < 1 {
				count = e.settings.Segments
			}
			if count > MaxConnections {
				count = MaxConnections
			}
			if int64(count) > *size/MinPartSize {
				count = int(*size / MinPartSize)
			}
			if count < 1 {
				count = 1
			}
		}
		for i := 0; i < count; i++ {
			part := Part{Start: 0, End: -1}
			if size != nil {
				part.Start = *size * int64(i) / int64(count)
				part.End = *size*int64(i+1)/int64(count) - 1
			}
			j.Parts = append(j.Parts, part)
		}
	}
	parts := append([]Part(nil), j.Parts...)
	e.mu.Unlock()
	if err = e.save(); err != nil {
		return err
	}
	if len(parts) > 1 && !ranges {
		return errors.New("server no longer supports multiple connections")
	}
	// Existing bytes on disk are authoritative; speed and progress counters are not.
	sizes := make([]int64, len(parts))
	var downloaded int64
	for i, p := range parts {
		info, err := os.Stat(e.partPath(j, i))
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if err == nil {
			sizes[i] = info.Size()
		}
		if p.End >= p.Start && sizes[i] > p.End-p.Start+1 {
			return errors.New("partial data exceeds its segment boundary")
		}
		downloaded += sizes[i]
	}
	e.mu.Lock()
	j.Downloaded = downloaded
	e.mu.Unlock()
	e.progressEvent()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	errch := make(chan error, len(parts))
	var wg sync.WaitGroup
	for i, p := range parts {
		i, p := i, p
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := e.fetchPart(ctx, j, i, p, sizes[i], ranges); err != nil {
				cancel()
				errch <- err
			}
		}()
	}
	wg.Wait()
	close(errch)
	for x := range errch {
		if x != nil {
			return x
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	e.mu.Lock()
	status := j.Status
	e.mu.Unlock()
	if status != "downloading" {
		return context.Canceled
	}
	return e.assemble(j)
}
func (e *Engine) partPath(j *Job, i int) string {
	return filepath.Join(j.Directory, fmt.Sprintf(".ywd-%s-%d.part", j.ID, i))
}
func (e *Engine) fetchPart(ctx context.Context, j *Job, i int, p Part, existing int64, ranges bool) error {
	dest := e.partPath(j, i)
	for attempt := 0; attempt < 3; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !ranges && existing != 0 {
			if err := os.Truncate(dest, 0); err != nil {
				return err
			}
			e.mu.Lock()
			j.Downloaded -= existing
			e.mu.Unlock()
			existing = 0
		}
		err := e.fetchOnce(ctx, j, dest, p, existing, ranges)
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if attempt == 2 {
			return err
		}
		info, statErr := os.Stat(dest)
		if statErr == nil {
			existing = info.Size()
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(attempt+1) * 300 * time.Millisecond):
		}
	}
	return errors.New("exhausted retries")
}
func (e *Engine) fetchOnce(ctx context.Context, j *Job, dest string, p Part, existing int64, ranges bool) error {
	h := http.Header{}
	start := p.Start + existing
	useRange := ranges && p.End >= 0
	if useRange {
		h.Set("Range", fmt.Sprintf("bytes=%d-%d", start, p.End))
		if j.Validator != "" {
			h.Set("If-Range", j.Validator)
		}
	}
	if p.End >= p.Start && existing == p.End-p.Start+1 {
		return nil
	}
	res, err := e.clientRequest(ctx, http.MethodGet, j.URL, h)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	expectedStatus := 200
	if useRange {
		expectedStatus = 206
	}
	if res.StatusCode != expectedStatus {
		return fmt.Errorf("unexpected HTTP %d (expected %d)", res.StatusCode, expectedStatus)
	}
	if enc := res.Header.Get("Content-Encoding"); enc != "" && !strings.EqualFold(enc, "identity") {
		return errors.New("unexpected compressed HTTP body")
	}
	if useRange {
		a, b, total, ok := parseContentRange(res.Header.Get("Content-Range"))
		if !ok || a != start || b != p.End || (j.Total != nil && total != *j.Total) {
			return errors.New("mismatched Content-Range; refusing corrupt file")
		}
	}
	flag := os.O_CREATE | os.O_WRONLY
	if existing > 0 {
		flag |= os.O_APPEND
	} else {
		flag |= os.O_TRUNC
	}
	file, err := os.OpenFile(dest, flag, 0600)
	if err != nil {
		return err
	}
	buffer := make([]byte, 64*1024)
	last := time.Now()
	lastBytes := int64(0)
	for {
		n, readErr := res.Body.Read(buffer)
		if n > 0 {
			written, writeErr := file.Write(buffer[:n])
			if writeErr != nil {
				file.Close()
				return writeErr
			}
			if written != n {
				file.Close()
				return io.ErrShortWrite
			}
			e.mu.Lock()
			j.Downloaded += int64(written)
			elapsed := time.Since(last)
			lastBytes += int64(written)
			if elapsed > 500*time.Millisecond {
				j.Speed = int64(float64(lastBytes) / elapsed.Seconds())
				last = time.Now()
				lastBytes = 0
			}
			e.mu.Unlock()
			e.progressEvent()
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			file.Close()
			return readErr
		}
		if err := ctx.Err(); err != nil {
			file.Close()
			return err
		}
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if p.End >= p.Start {
		info, err := os.Stat(dest)
		if err != nil {
			return err
		}
		if info.Size() != p.End-p.Start+1 {
			return fmt.Errorf("incomplete segment: expected %d got %d", p.End-p.Start+1, info.Size())
		}
	}
	return nil
}
func (e *Engine) assemble(j *Job) error {
	tmp := j.Target + ".assembling-" + j.ID
	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	var total int64
	for i := range j.Parts {
		part, err := os.Open(e.partPath(j, i))
		if err != nil {
			out.Close()
			os.Remove(tmp)
			return err
		}
		n, err := io.Copy(out, part)
		part.Close()
		if err != nil {
			out.Close()
			os.Remove(tmp)
			return err
		}
		total += n
	}
	if err := out.Sync(); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if j.Total != nil && total != *j.Total {
		os.Remove(tmp)
		return errors.New("final size verification failed; partial segments were retained")
	}
	e.mu.Lock()
	target, err := e.uniqueTargetLocked(j.Directory, j.FileName)
	// The current job reserves its own destination name, so use original name if no file appeared.
	if _, statErr := os.Stat(j.Target); os.IsNotExist(statErr) {
		target = j.Target
		err = nil
	}
	e.mu.Unlock()
	if err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, target); err != nil {
		os.Remove(tmp)
		return err
	}
	e.mu.Lock()
	j.Target = target
	j.FileName = filepath.Base(target)
	if j.Total == nil {
		j.Total = &total
	}
	j.Downloaded = total
	e.mu.Unlock()
	for i := range j.Parts {
		_ = os.Remove(e.partPath(j, i))
	}
	return nil
}
func (e *Engine) Get(id string) (*Job, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	j, err := e.findLocked(id)
	if err != nil {
		return nil, err
	}
	cp := *j
	return &cp, nil
}
func (e *Engine) Close() error {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return nil
	}
	e.closed = true
	close(e.done)
	for id, cancel := range e.active {
		cancel()
		if j, err := e.findLocked(id); err == nil && j.Status == "downloading" {
			j.Status = "queued"
			j.Speed = 0
		}
	}
	e.mu.Unlock()
	e.wg.Wait()
	return e.save()
}
