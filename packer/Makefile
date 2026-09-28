# Overridable, since Go is not in the same place on every
# machine. Falls back to whatever is on the PATH.
GO ?= $(shell command -v go || echo /opt/go/current/bin/go)

# Version injected at build time: YYYYMMDD-seconds_since_midnight
VERSION := $(shell date '+%Y%m%d %H %M %S' | awk '{print $$1"-"($$2*3600+$$3*60+$$4)}')
LDFLAGS = -ldflags "-s -w -X main.version=$(VERSION)"

BIN = routepack
PKG = ./cli

# The page in docs/ is this same code compiled for a browser, so the
# site is a build target and not a second implementation.
SITE = ../docs
WASM = $(SITE)/navigator.wasm

all: test $(BIN)

$(BIN): $(shell find . -name '*.go')
	$(GO) build $(LDFLAGS) -o $(BIN) $(PKG)

test:
	$(GO) test ./...

vet:
	$(GO) vet ./...

# GOOS=js needs no network and no extra toolchain: the WebAssembly
# support and the loader script both ship with Go.
site: $(WASM)
	cp "$$($(GO) env GOROOT)/lib/wasm/wasm_exec.js" $(SITE)/wasm_exec.js
	@ls -lh $(WASM) | awk '{print "wasm", $$5}'

$(WASM): $(shell find . -name '*.go')
	GOOS=js GOARCH=wasm $(GO) build $(LDFLAGS) -o $(WASM) ./cli/wasm

clean:
	rm -f $(BIN)

.PHONY: all test vet site clean
