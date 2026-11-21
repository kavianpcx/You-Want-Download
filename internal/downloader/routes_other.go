//go:build !windows

package downloader

import "syscall"

// Non-Windows builds bind the local IPv4 address, but may additionally need
// policy routes to use a different gateway (depends on host OS routing).
func bindInterfaceControl(_ int) func(string, string, syscall.RawConn) error { return nil }
