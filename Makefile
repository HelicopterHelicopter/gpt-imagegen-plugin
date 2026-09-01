BIN := plugins/gpt-imagegen/bin/gpt-imagegen

.PHONY: build test smoke clean
build:
	go build -o $(BIN) ./cmd/gpt-imagegen

test:
	go test ./...

# Live smoke costs a real ChatGPT turn; opt in explicitly.
smoke: build
	GPT_IMAGEGEN_LIVE=1 go test ./tests/live/ -run TestLiveGenerate -v -timeout 15m

clean:
	rm -rf plugins/gpt-imagegen/bin dist
