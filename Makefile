BIN := plugins/gpt-imagegen/bin/gpt-imagegen
LOCAL_INSTALL_DIR := $(HOME)/.gpt-imagegen/bin

.PHONY: build test smoke clean install-local
build:
	go build -o $(BIN) ./cmd/gpt-imagegen

test:
	go test ./...

# Live smoke costs a real ChatGPT turn; opt in explicitly.
smoke: build
	GPT_IMAGEGEN_LIVE=1 go test ./tests/live/ -run TestLiveGenerate -v -timeout 15m

# Copies the built binary to ~/.gpt-imagegen/bin/, the shim's third
# resolution path (after $GPT_IMAGEGEN_BIN and the local ../bin/ build).
# This is the same place a downloaded release binary would go.
install-local: build
	mkdir -p $(LOCAL_INSTALL_DIR)
	cp $(BIN) $(LOCAL_INSTALL_DIR)/gpt-imagegen

clean:
	rm -rf plugins/gpt-imagegen/bin dist
