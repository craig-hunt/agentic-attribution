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

// A batch landing inside the clock's resolution would divide by zero. The line
// still has to say something useful, because "+Inf docs/sec" reads as a broken
// ingest rather than a fast first batch.
func TestReportProgressSurvivesAZeroDuration(t *testing.T) {
	var out bytes.Buffer
	p := &Pipeline{out: &out}

	p.reportProgress(2000, 20000, 0)

	line := out.String()
	if line == "" {
		t.Fatal("a zero duration reported nothing at all")
	}
	for _, unwanted := range []string{"Inf", "NaN"} {
		if strings.Contains(line, unwanted) {
			t.Errorf("progress line contains %s: %s", unwanted, line)
		}
	}
	for _, want := range []string{"2000", "20000", "10%"} {
		if !strings.Contains(line, want) {
			t.Errorf("progress line omits %q: %s", want, line)
		}
	}
}

func TestReportProgressRejectsANegativeDuration(t *testing.T) {
	var out bytes.Buffer
	p := &Pipeline{out: &out}

	// A clock adjustment mid-run can hand back a negative elapsed time, which
	// would print a negative rate and a remaining time in the past.
	p.reportProgress(2000, 20000, -time.Second)

	if line := out.String(); strings.Contains(line, "-") {
		t.Errorf("a negative duration produced a negative figure: %s", line)
	}
}
