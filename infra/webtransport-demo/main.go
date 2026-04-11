package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

// Configure via environment variables:
//
//	WT_DOMAIN    - your domain (e.g. wt.yourdomain.com)
//	WT_CERT_DIR  - cert directory (default: /etc/letsencrypt/live/$WT_DOMAIN)
func getConfig() (domain, certFile, keyFile string) {
	domain = os.Getenv("WT_DOMAIN")
	if domain == "" {
		log.Fatal("WT_DOMAIN environment variable is required (e.g. wt.yourdomain.com)")
	}
	certDir := os.Getenv("WT_CERT_DIR")
	if certDir == "" {
		certDir = "/etc/letsencrypt/live/" + domain
	}
	return domain, certDir + "/fullchain.pem", certDir + "/privkey.pem"
}

// Message represents a chat message
type Message struct {
	Type      string `json:"type"`
	Text      string `json:"text,omitempty"`
	From      string `json:"from,omitempty"`
	Timestamp int64  `json:"timestamp"`
	Clients   int    `json:"clients,omitempty"`
}

// Hub manages connected WebTransport sessions
type Hub struct {
	mu       sync.RWMutex
	sessions map[*webtransport.Session]string
	counter  int
}

func NewHub() *Hub {
	return &Hub{sessions: make(map[*webtransport.Session]string)}
}

func (h *Hub) Add(sess *webtransport.Session) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.counter++
	id := fmt.Sprintf("User-%d", h.counter)
	h.sessions[sess] = id
	return id
}

func (h *Hub) Remove(sess *webtransport.Session) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.sessions, sess)
}

func (h *Hub) Count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.sessions)
}

func (h *Hub) Broadcast(msg Message) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for sess := range h.sessions {
		sess.SendDatagram(data)
	}
}

var hub = NewHub()

func main() {
	domain, certFile, keyFile := getConfig()
	log.Printf("domain: %s", domain)

	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		log.Fatalf("failed to load certs: %v", err)
	}

	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
		NextProtos:   []string{"h3"},
	}

	// WebTransport server (UDP 443)
	wtServer := &webtransport.Server{
		H3: &http3.Server{
			Addr:      ":443",
			TLSConfig: tlsConfig,
		},
		CheckOrigin: func(r *http.Request) bool { return true },
	}
	webtransport.ConfigureHTTP3Server(wtServer.H3)

	wtMux := http.NewServeMux()

	// Echo endpoint for diagnostics — echoes streams and datagrams
	wtMux.HandleFunc("/echo", func(w http.ResponseWriter, r *http.Request) {
		session, err := wtServer.Upgrade(w, r)
		if err != nil {
			log.Printf("echo upgrade failed: %v", err)
			return
		}
		log.Println("echo session connected")

		// Echo bidi streams
		go func() {
			for {
				stream, err := session.AcceptStream(context.Background())
				if err != nil {
					return
				}
				go func() {
					defer stream.Close()
					buf := make([]byte, 4096)
					for {
						n, err := stream.Read(buf)
						if err != nil {
							return
						}
						stream.Write(buf[:n])
					}
				}()
			}
		}()

		// Echo datagrams
		for {
			msg, err := session.ReceiveDatagram(context.Background())
			if err != nil {
				return
			}
			session.SendDatagram(msg)
		}
	})

	wtMux.HandleFunc("/wt", func(w http.ResponseWriter, r *http.Request) {
		session, err := wtServer.Upgrade(w, r)
		if err != nil {
			log.Printf("upgrade failed: %v", err)
			return
		}

		clientID := hub.Add(session)
		log.Printf("client connected: %s (total: %d)", clientID, hub.Count())

		hub.Broadcast(Message{
			Type:      "system",
			Text:      clientID + " joined",
			Timestamp: time.Now().UnixMilli(),
			Clients:   hub.Count(),
		})

		defer func() {
			hub.Remove(session)
			log.Printf("client disconnected: %s (total: %d)", clientID, hub.Count())
			hub.Broadcast(Message{
				Type:      "system",
				Text:      clientID + " left",
				Timestamp: time.Now().UnixMilli(),
				Clients:   hub.Count(),
			})
		}()

		// Handle bidirectional streams (reliable chat messages)
		go func() {
			for {
				stream, err := session.AcceptStream(context.Background())
				if err != nil {
					log.Printf("AcceptStream error for %s: %v", clientID, err)
					return
				}
				log.Printf("accepted stream from %s", clientID)
				go handleChatStream(session, stream, clientID)
			}
		}()

		// Handle incoming datagrams (ping + chat)
		for {
			msg, err := session.ReceiveDatagram(context.Background())
			if err != nil {
				return
			}
			var incoming Message
			if json.Unmarshal(msg, &incoming) != nil {
				continue
			}
			switch incoming.Type {
			case "ping":
				reply, _ := json.Marshal(Message{
					Type:      "pong",
					Timestamp: time.Now().UnixMilli(),
				})
				session.SendDatagram(reply)
			case "chat":
				log.Printf("message from %s: %s", clientID, incoming.Text)
				hub.Broadcast(Message{
					Type:      "chat",
					Text:      incoming.Text,
					From:      clientID,
					Timestamp: time.Now().UnixMilli(),
					Clients:   hub.Count(),
				})
			}
		}
	})
	wtServer.H3.Handler = wtMux

	// Regular HTTPS server (TCP 443) for the demo page
	httpsMux := http.NewServeMux()
	httpsMux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(demoHTML))
	})
	httpsMux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})
	httpsMux.HandleFunc("/diag", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(diagHTML))
	})

	go func() {
		log.Println("HTTPS server (TCP) listening on :443")
		srv := &http.Server{
			Addr:    ":443",
			Handler: httpsMux,
			TLSConfig: &tls.Config{
				Certificates: []tls.Certificate{cert},
				MinVersion:   tls.VersionTLS13,
			},
		}
		if err := srv.ListenAndServeTLS("", ""); err != nil {
			log.Fatalf("HTTPS server error: %v", err)
		}
	}()

	log.Println("WebTransport server (UDP) listening on :443")
	if err := wtServer.ListenAndServe(); err != nil {
		log.Fatalf("WebTransport server error: %v", err)
	}
}

func handleChatStream(sender *webtransport.Session, stream *webtransport.Stream, clientID string) {
	defer stream.Close()
	buf := make([]byte, 4096)
	for {
		n, err := stream.Read(buf)
		if err != nil {
			if err != io.EOF {
				log.Printf("stream read error: %v", err)
			}
			return
		}
		text := string(buf[:n])
		log.Printf("message from %s: %s", clientID, text)

		hub.Broadcast(Message{
			Type:      "chat",
			Text:      text,
			From:      clientID,
			Timestamp: time.Now().UnixMilli(),
			Clients:   hub.Count(),
		})
	}
}
