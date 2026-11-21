package downloader

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// NetworkLink is a usable, up IPv4 adapter. Virtual/VPN adapters can appear;
// users can choose adapters manually rather than relying on the OS default route.
type NetworkLink struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Address string `json:"address"`
	Index   int    `json:"index"`
	ip      net.IP
}

func AvailableLinks() []NetworkLink {
	all, err := net.Interfaces()
	if err != nil {
		return []NetworkLink{}
	}
	result := []NetworkLink{}
	for _, iface := range all {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ip, _, err := net.ParseCIDR(a.String())
			if err != nil || ip.To4() == nil || !ip.IsGlobalUnicast() || ip.IsLinkLocalUnicast() {
				continue
			}
			ip = ip.To4()
			result = append(result, NetworkLink{ID: iface.Name, Label: fmt.Sprintf("%s · %s", iface.Name, ip.String()), Address: ip.String(), Index: iface.Index, ip: ip})
			break
		}
	}
	return result
}

func (e *Engine) clientsFor(settings Settings) ([]*http.Client, func(), error) {
	var proxy func(*http.Request) (*url.URL, error)
	if settings.ProxyURL != "" {
		u, err := url.Parse(settings.ProxyURL)
		if err != nil {
			return nil, nil, err
		}
		proxy = http.ProxyURL(u)
	} else {
		proxy = http.ProxyFromEnvironment
	}
	makeClient := func(link *NetworkLink) (*http.Client, *http.Transport) {
		dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
		if link != nil {
			dialer.LocalAddr = &net.TCPAddr{IP: link.ip}
			dialer.Control = bindInterfaceControl(link.Index)
		}
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = proxy
		transport.DialContext = dialer.DialContext
		transport.ForceAttemptHTTP2 = false // do not multiplex all segments onto one connection
		transport.MaxIdleConnsPerHost = MaxConnections + 2
		transport.ResponseHeaderTimeout = 25 * time.Second
		transport.DisableCompression = true
		client := &http.Client{Transport: transport, CheckRedirect: func(r *http.Request, via []*http.Request) error {
			if len(via) >= 8 || (r.URL.Scheme != "http" && r.URL.Scheme != "https") {
				return errors.New("unsafe redirect")
			}
			return nil
		}}
		return client, transport
	}
	links := []NetworkLink{}
	if settings.NetworkMode == "combine" {
		all := AvailableLinks()
		if len(settings.Interfaces) == 0 {
			links = all
		} else {
			for _, name := range settings.Interfaces {
				for _, candidate := range all {
					if strings.EqualFold(candidate.ID, name) {
						links = append(links, candidate)
						break
					}
				}
			}
		}
		if len(links) == 0 {
			return nil, nil, errors.New("no selected network adapter is active; check Settings → Connection")
		}
		if len(links) > 8 {
			links = links[:8]
		}
	}
	clients := []*http.Client{}
	transports := []*http.Transport{}
	if len(links) == 0 {
		client, tr := makeClient(nil)
		clients = append(clients, client)
		transports = append(transports, tr)
	} else {
		for i := range links {
			client, tr := makeClient(&links[i])
			clients = append(clients, client)
			transports = append(transports, tr)
		}
	}
	clean := func() {
		for _, tr := range transports {
			tr.CloseIdleConnections()
		}
	}
	return clients, clean, nil
}
