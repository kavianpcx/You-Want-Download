package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/kavianpcx/You-Want-Download/internal/downloader"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const Version = "0.3.0"
const ReleasesURL = "https://github.com/kavianpcx/You-Want-Download/releases"

type App struct {
	ctx    context.Context
	engine *downloader.Engine
}
type AppState struct {
	downloader.Snapshot
	Version  string `json:"version"`
	Portable bool   `json:"portable"`
}
type UpdateInfo struct {
	Status  string `json:"status"`
	Message string `json:"message"`
	Version string `json:"version,omitempty"`
	URL     string `json:"url"`
}

func NewApp() *App { return &App{} }
func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
	config, err := os.UserConfigDir()
	if err != nil {
		config, _ = os.UserHomeDir()
	}
	root := filepath.Join(config, "YouWantDownload")
	statePath := filepath.Join(root, "downloads.json")
	// Best-effort, one-way history migration from the previous Electron edition.
	if _, err := os.Stat(statePath); os.IsNotExist(err) {
		for _, name := range []string{"you-want-download", "You Want Download"} {
			old := filepath.Join(config, name, "downloads.json")
			if file, err := os.Open(old); err == nil {
				_ = os.MkdirAll(root, 0700)
				if dest, err := os.OpenFile(statePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600); err == nil {
					_, _ = io.Copy(dest, file)
					_ = dest.Close()
				}
				_ = file.Close()
				break
			}
		}
	}
	home, _ := os.UserHomeDir()
	downloads := filepath.Join(home, "Downloads")
	a.engine = downloader.New(statePath, downloads)
	a.engine.SetOnChange(func() {
		if a.ctx != nil {
			wailsruntime.EventsEmit(a.ctx, "downloads:changed", a.engine.Snapshot())
		}
	})
	if err := a.engine.Init(); err != nil {
		wailsruntime.MessageDialog(ctx, wailsruntime.MessageDialogOptions{Type: wailsruntime.ErrorDialog, Title: "Download manager error", Message: err.Error()})
	}
}
func (a *App) Shutdown(_ context.Context) {
	if a.engine != nil {
		_ = a.engine.Close()
	}
}
func (a *App) State() AppState {
	if a.engine == nil {
		return AppState{Version: Version, Snapshot: downloader.Snapshot{Items: []*downloader.Job{}}}
	}
	return AppState{Snapshot: a.engine.Snapshot(), Version: Version, Portable: true}
}
func (a *App) Add(arg downloader.AddRequest) (string, error) {
	if a.engine == nil {
		return "", errors.New("engine not ready")
	}
	return a.engine.Add(arg)
}
func (a *App) Pause(id string) error                      { return a.engine.Pause(id) }
func (a *App) Resume(id string) error                     { return a.engine.Resume(id) }
func (a *App) Remove(id string) error                     { return a.engine.Remove(id) }
func (a *App) SetConnections(id string, n int) error      { return a.engine.SetConnections(id, n) }
func (a *App) UpdateSettings(s downloader.Settings) error { return a.engine.UpdateSettings(s) }
func (a *App) ChooseDirectory() (string, error) {
	return wailsruntime.OpenDirectoryDialog(a.ctx, wailsruntime.OpenDialogOptions{Title: "Choose download folder"})
}
func (a *App) Clipboard() (string, error)                  { return wailsruntime.ClipboardGetText(a.ctx) }
func (a *App) NetworkInterfaces() []downloader.NetworkLink { return downloader.AvailableLinks() }
func (a *App) OpenDownloadDirectory() error {
	dir := a.engine.Snapshot().Settings.DownloadDirectory
	if dir == "" {
		return errors.New("set a download folder in Settings")
	}
	if runtime.GOOS == "windows" {
		return exec.Command("explorer.exe", dir).Start()
	}
	if runtime.GOOS == "darwin" {
		return exec.Command("open", dir).Start()
	}
	return exec.Command("xdg-open", dir).Start()
}
func (a *App) PauseAll() error {
	for _, j := range a.engine.Snapshot().Items {
		if j.Status == "downloading" || j.Status == "queued" {
			if err := a.engine.Pause(j.ID); err != nil {
				return err
			}
		}
	}
	return nil
}
func (a *App) ResumeAll() error {
	for _, j := range a.engine.Snapshot().Items {
		if j.Status == "paused" {
			if err := a.engine.Resume(j.ID); err != nil {
				return err
			}
		}
	}
	return nil
}
func (a *App) ClearCompleted() error {
	for _, j := range a.engine.Snapshot().Items {
		if j.Status == "completed" {
			if err := a.engine.Remove(j.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

func (a *App) ShowFile(id string) error {
	j, err := a.engine.Get(id)
	if err != nil {
		return err
	}
	if j.Status != "completed" {
		return errors.New("file is not completed")
	}
	switch runtime.GOOS {
	case "windows":
		return exec.Command("explorer.exe", "/select,", j.Target).Start()
	case "darwin":
		return exec.Command("open", "-R", j.Target).Start()
	default:
		return exec.Command("xdg-open", filepath.Dir(j.Target)).Start()
	}
}
func (a *App) OpenReleases() { wailsruntime.BrowserOpenURL(a.ctx, ReleasesURL) }
func (a *App) OpenRepository() {
	wailsruntime.BrowserOpenURL(a.ctx, "https://github.com/kavianpcx/You-Want-Download")
}
func parseVersion(v string) (int, int, int) {
	parts := strings.Split(strings.TrimPrefix(v, "v"), ".")
	res := []int{0, 0, 0}
	for i := 0; i < len(parts) && i < 3; i++ {
		res[i], _ = strconv.Atoi(parts[i])
	}
	return res[0], res[1], res[2]
}
func newer(v, current string) bool {
	a, b, c := parseVersion(v)
	x, y, z := parseVersion(current)
	return a > x || (a == x && b > y) || (a == x && b == y && c > z)
}
func (a *App) CheckUpdate() UpdateInfo {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/repos/kavianpcx/You-Want-Download/releases/latest", nil)
	if err != nil {
		return UpdateInfo{Status: "error", Message: err.Error(), URL: ReleasesURL}
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "You-Want-Download/0.3")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return UpdateInfo{Status: "error", Message: err.Error(), URL: ReleasesURL}
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return UpdateInfo{Status: "error", Message: fmt.Sprintf("GitHub returned HTTP %d", res.StatusCode), URL: ReleasesURL}
	}
	var info struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
	}
	if err = json.NewDecoder(io.LimitReader(res.Body, 64*1024)).Decode(&info); err != nil {
		return UpdateInfo{Status: "error", Message: err.Error(), URL: ReleasesURL}
	}
	if info.HTMLURL == "" {
		info.HTMLURL = ReleasesURL
	}
	if newer(info.TagName, Version) {
		return UpdateInfo{Status: "available", Message: "A newer version is available. Open its release page to download it.", Version: info.TagName, URL: info.HTMLURL}
	}
	return UpdateInfo{Status: "current", Message: "You have the latest published version.", Version: Version, URL: ReleasesURL}
}
