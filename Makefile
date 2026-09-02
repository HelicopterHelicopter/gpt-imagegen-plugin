BIN := plugins/gpt-imagegen/bin/gpt-imagegen
LOCAL_INSTALL_DIR := $(HOME)/.gpt-imagegen/bin
INSTALL_RELEASE_SCRIPT := plugins/gpt-imagegen/scripts/install-release

.PHONY: build test smoke clean install-local install-release
build:
	go build -o $(BIN) ./cmd/gpt-imagegen

test:
	go test ./...

# Live smoke costs a real ChatGPT turn; opt in explicitly.
smoke: build
	GPT_IMAGEGEN_LIVE=1 go test ./tests/live/ -run TestLiveGenerate -v -timeout 15m

# Copies a LOCALLY BUILT binary to ~/.gpt-imagegen/bin/, the shim's third
# resolution path (after $GPT_IMAGEGEN_BIN and the local ../bin/ build).
# For people building from source. See install-release for the alternative
# that downloads a checksum-verified release binary instead of building.
install-local: build
	mkdir -p $(LOCAL_INSTALL_DIR)
	cp $(BIN) $(LOCAL_INSTALL_DIR)/gpt-imagegen

# Downloads a prebuilt, checksum-verified release binary to the same
# ~/.gpt-imagegen/bin/ path, for people who don't have Go installed. See
# install-local for the from-source alternative. Pass a tag to pin a
# specific release, e.g. `make install-release TAG=v0.1.0`.
install-release:
	$(INSTALL_RELEASE_SCRIPT) $(TAG)

clean:
	rm -rf plugins/gpt-imagegen/bin dist
