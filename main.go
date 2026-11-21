package main

import (
	"embed"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	"log"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	application := NewApp()
	err := wails.Run(&options.App{
		Title: "You Want Download", Width: 1030, Height: 685, MinWidth: 830, MinHeight: 510,
		BackgroundColour: &options.RGBA{R: 15, G: 19, B: 27, A: 1},
		AssetServer:      &assetserver.Options{Assets: assets},
		Windows:          &windows.Options{WebviewIsTransparent: false, DisableWindowIcon: false},
		OnStartup:        application.Startup, OnShutdown: application.Shutdown, Bind: []interface{}{application},
	})
	if err != nil {
		log.Fatal(err)
	}
}
