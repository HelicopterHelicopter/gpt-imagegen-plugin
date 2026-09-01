package main

import (
	"fmt"
	"io"
	"os"
	"runtime/debug"

	"github.com/jheel-knot/gpt-imagegen-plugin/internal/envelope"
)

func main() {
	os.Exit(safeRun(func() int { return run(os.Args[1:], os.Stdout, os.Stderr) }, os.Stdout, os.Stderr))
}

// safeRun runs fn, converting a panic into a single JSON failure line on
// stdout so the "exactly one line of JSON" contract holds even when the
// process is failing: without this, a panic would write nothing to stdout
// at all, leaving the skill with unparseable empty output at exactly the
// moment something has gone badly wrong. fn is injectable so this recover
// wiring is testable without a self-exec or a hidden CLI command. The panic
// value and stack are logged to stderr only; they never appear in the
// stdout JSON, which carries a fixed, generic message instead (the panic
// value could be arbitrary and is not safe to echo onto the one channel the
// skill parses).
func safeRun(fn func() int, stdout, stderr io.Writer) (code int) {
	defer func() {
		if v := recover(); v != nil {
			fmt.Fprintf(stderr, "panic: %v\n%s\n", v, debug.Stack())
			code = emitPanic(stdout)
		}
	}()
	return fn()
}

// emitPanic writes a single REFUSED failure JSON line to w, with a fixed
// generic message, and returns the exit code. It never includes the panic
// value itself: that goes to stderr only (see safeRun), never stdout.
// emitPanic cannot itself panic: Result.Write's error, if any (e.g. a
// closed stdout), is deliberately ignored rather than propagated.
func emitPanic(w io.Writer) int {
	r := envelope.Failure(envelope.CodeRefused, "internal error; see stderr for details")
	_ = r.Write(w)
	return r.ExitCode()
}
