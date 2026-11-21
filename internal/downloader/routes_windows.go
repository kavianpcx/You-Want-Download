//go:build windows

package downloader

import (
	"syscall"
)

// IP_UNICAST_IF overrides Windows' single default route for each TCP socket.
// Windows expects the IPv4 interface index in network byte order.
func bindInterfaceControl(index int) func(string, string, syscall.RawConn) error {
	return func(network, address string, c syscall.RawConn) error {
		var sockErr error
		err := c.Control(func(fd uintptr) {
			const ipUnicastIF = 31
			n := uint32(index)
			networkOrder := uint32(byte(n))<<24 | uint32(byte(n>>8))<<16 | uint32(byte(n>>16))<<8 | uint32(byte(n>>24))
			sockErr = syscall.SetsockoptInt(syscall.Handle(fd), syscall.IPPROTO_IP, ipUnicastIF, int(networkOrder))
		})
		if err != nil {
			return err
		}
		return sockErr
	}
}
