package ingest

import (
	"encoding/csv"
	"strings"
	"testing"
)

// Passing every CSV field as a string forces Postgres to cast per row, which
// shows up as measurable CPU across a million listings. These conversions are
// the reason the COPY stays cheap.
func TestCoerceConvertsToTheTypesPgxBindsDirectly(t *testing.T) {
	cases := []struct {
		raw  string
		want any
	}{
		{"t", true},
		{"f", false},
		{"0", int64(0)},
		{"12999", int64(12999)},
		{"-5", int64(-5)},
		{"9223372036854775807", int64(9223372036854775807)},
		{"prd_00000001", "prd_00000001"},
		{"", ""},
		{"12.5", "12.5"},
		{"true", "true"},
		{"false", "false"},
		{"T", "T"},
		{"9223372036854775808", "9223372036854775808"},
		{`{"color":"red"}`, `{"color":"red"}`},
	}

	for _, tc := range cases {
		t.Run(tc.raw, func(t *testing.T) {
			if got := coerce(tc.raw); got != tc.want {
				t.Fatalf("coerce(%q) = %#v, want %#v", tc.raw, got, tc.want)
			}
		})
	}
}

// "true" and "false" stay strings deliberately. Postgres COPY writes booleans
// as t and f, so anything else arriving in a boolean column means the file did
// not come from the generator and should fail loudly at the column rather than
// silently coerce.
func TestCoerceDoesNotGuessAtBooleanSpellings(t *testing.T) {
	for _, raw := range []string{"true", "false", "TRUE", "yes", "no", "1"} {
		got := coerce(raw)

		if _, isBool := got.(bool); isBool {
			t.Fatalf("coerce(%q) produced a bool; only t and f should", raw)
		}
	}
}

func newSource(t *testing.T, content string, columns int) *csvCopySource {
	t.Helper()

	reader := csv.NewReader(strings.NewReader(content))

	// The header is consumed before copying begins, mirroring the loader.
	if _, err := reader.Read(); err != nil {
		t.Fatalf("read header: %v", err)
	}

	return &csvCopySource{reader: reader, columnCount: columns}
}

func TestCopySourceStreamsEveryRow(t *testing.T) {
	source := newSource(t, "id,qty,ok\na,1,t\nb,2,f\nc,30,t\n", 3)

	var rows [][]any
	for source.Next() {
		values, err := source.Values()
		if err != nil {
			t.Fatalf("Values: %v", err)
		}
		rows = append(rows, values)
	}

	if err := source.Err(); err != nil {
		t.Fatalf("Err: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("streamed %d rows, want 3", len(rows))
	}

	if rows[0][0] != "a" || rows[0][1] != int64(1) || rows[0][2] != true {
		t.Fatalf("first row = %#v", rows[0])
	}
	if rows[2][1] != int64(30) || rows[2][2] != true {
		t.Fatalf("last row = %#v", rows[2])
	}
}

// A short or long row means the file disagrees with the COPY statement's
// column list. Continuing would load fields into the wrong columns, so the
// source stops and reports rather than doing its best.
func TestCopySourceStopsOnAColumnCountMismatch(t *testing.T) {
	cases := []struct {
		name    string
		content string
	}{
		{"a row missing a column", "id,qty,ok\na,1,t\nb,2\n"},
		{"a row carrying an extra column", "id,qty,ok\na,1,t,surplus\n"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			source := newSource(t, tc.content, 3)

			for source.Next() {
			}

			if source.Err() == nil {
				t.Fatal("the source finished cleanly despite a column count mismatch")
			}

			// encoding/csv pins FieldsPerRecord from the header and rejects a
			// ragged row before the source's own check runs. The explicit
			// count check stays as a guard for a reader configured otherwise.
			if !strings.Contains(source.Err().Error(), "fields") &&
				!strings.Contains(source.Err().Error(), "columns") {
				t.Fatalf("error does not name the cause: %v", source.Err())
			}
		})
	}
}

func TestCopySourceHandlesAFileCarryingOnlyAHeader(t *testing.T) {
	source := newSource(t, "id,qty,ok\n", 3)

	if source.Next() {
		t.Fatal("the source produced a row from a header-only file")
	}
	if err := source.Err(); err != nil {
		t.Fatalf("a header-only file reported %v, want a clean end", err)
	}
}

// Quoted fields carrying embedded commas and newlines have to survive, because
// product descriptions and JSON attributes contain both.
func TestCopySourcePreservesQuotedFields(t *testing.T) {
	source := newSource(t, "id,title,attrs\n"+
		`a,"Widget, 12"" model","{""color"":""red""}"`+"\n", 3)

	if !source.Next() {
		t.Fatalf("no row produced: %v", source.Err())
	}

	values, err := source.Values()
	if err != nil {
		t.Fatalf("Values: %v", err)
	}

	if values[1] != `Widget, 12" model` {
		t.Errorf("title = %#v", values[1])
	}
	if values[2] != `{"color":"red"}` {
		t.Errorf("attrs = %#v", values[2])
	}
}

func TestCopySourceSurfacesAMalformedFile(t *testing.T) {
	source := newSource(t, "id,title\n"+`a,"unterminated`+"\n", 2)

	for source.Next() {
	}

	if source.Err() == nil {
		t.Fatal("the source finished cleanly on a malformed CSV")
	}
}

// Bodies get truncated before they reach a log line, so a multi-megabyte
// OpenSearch error cannot flood the output. The trailing marker matters: a
// silently cut body reads as the whole response and sends a reader hunting for
// a cause that got trimmed off.
func TestTruncateBoundsLoggedBodies(t *testing.T) {
	cases := []struct {
		name  string
		input string
		max   int
		want  string
	}{
		{"shorter than the limit passes through", "short", 100, "short"},
		{"exactly the limit passes through", "12345", 5, "12345"},
		{"longer than the limit gets cut and marked", "1234567890", 5, "12345..."},
		{"empty stays empty", "", 10, ""},
		{"a zero limit leaves only the marker", "abc", 0, "..."},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := truncate([]byte(tc.input), tc.max); got != tc.want {
				t.Fatalf("truncate(%q, %d) = %q, want %q", tc.input, tc.max, got, tc.want)
			}
		})
	}
}
