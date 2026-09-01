package main

import (
	"fmt"
	"io"
	"os"
	"runtime/debug"

	"github.com/jheelr/gpt-imagegen/internal/envelope"
)

func main() {
	os.Exit(safeRun(os.Args[1:], os.Stdout, os.Stderr))
}

// safeRun wraps run with a panic recovery so that a crash anywhere in the
// call chain still honours the hard rule that stdout carries exactly one
// JSON line: without this, a panic would write nothing to stdout at all,
// leaving the skill with unparseable empty output at exactly the moment
// something has gone badly wrong. The panic value and stack are reported on
// stderr only, never stdout.
func safeRun(args []string, stdout, stderr io.Writer) (code int) {
	defer func() {
		if v := recover(); v != nil {
			fmt.Fprintf(stderr, "panic: %v\n%s\n", v, debug.Stack())
			code = emitPanic(stdout, v)
		}
	}()
	return run(args, stdout, stderr)
}

// emitPanic writes a single REFUSED failure JSON line to w and returns the
// exit code. It cannot itself panic: Result.Write's error, if any (e.g. a
// closed stdout), is deliberately ignored rather than propagated.
func emitPanic(w io.Writer, v any) int {
	r := envelope.Failure(envelope.CodeRefused, fmt.Sprintf("internal error: %v", v))
	_ = r.Write(w)
	return r.ExitCode()
}
