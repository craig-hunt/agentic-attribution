package ingest

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

// Indexing runs for minutes with nothing else to show for it, so the progress
// line is the only signal separating a slow run from a wedged one.
func TestReportProgressNamesTheCountAndTheRemainder(t *testing.T) {
	var out bytes.Buffer
	p := &Pipeline{out: &out}

	p.reportProgress(5000, 20000, 50*time.Second)

	line := out.String()
	for _, want := range []string{"5000", "20000", "25%", "100 docs/sec", "2m30s"} {
		if !strings.Contains(line, want) {
			t.Errorf("progress line omits %q: %s", want, line)
		}
	}
}

func TestReportProgressSaysNothingLeftAtTheEnd(t *testing.T) {
	var out bytes.Buffer
	p := &Pipeline{out: &out}

	p.reportProgress(20000, 20000, 200*time.Second)

	line := out.String()
	if !strings.Contains(line, "100%") {
		t.Errorf("a finished run does not report 100%%: %s", line)
	}
	if !strings.Contains(line, "about 0s left") {
		t.Errorf("a finished run still predicts time remaining: %s", line)
	}
}

// A zero total would divide by zero and print a percentage of NaN.
func TestReportProgressSkipsAnEmptyCatalog(t *testing.T) {
	var out bytes.Buffer
	p := &Pipeline{out: &out}

	p.reportProgress(0, 0, time.Second)

	if out.Len() != 0 {
		t.Errorf("reported progress against an empty catalog: %s", out.String())
	}
}
