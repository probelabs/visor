// Command trace-annotation-scanner compares Go source pairs for the bounded
// traces-light promotion policy. It deliberately uses go/scanner rather than
// line-oriented matching so text in raw strings is never mistaken for source
// comments.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"go/scanner"
	"go/token"
	"io"
	"os"
	"strings"
)

type request struct {
	RequirementIDs []string `json:"requirement_ids"`
	Files          []file   `json:"files"`
}

type file struct {
	Path     string `json:"path"`
	Baseline string `json:"baseline"`
	Current  string `json:"current"`
}

type response struct {
	Allowed bool   `json:"allowed"`
	Reason  string `json:"reason,omitempty"`
}

var annotationPrefixes = [...]string{
	"// Implements:",
	"// Verifies:",
	"// Documents:",
}

func main() {
	var input request
	decoder := json.NewDecoder(os.Stdin)
	if err := decoder.Decode(&input); err != nil {
		writeResponse(response{Reason: fmt.Sprintf("invalid scanner input: %v", err)})
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeResponse(response{Reason: "scanner input contains trailing JSON"})
		return
	}

	allowedIDs := make(map[string]struct{}, len(input.RequirementIDs))
	for _, id := range input.RequirementIDs {
		if id == "" {
			writeResponse(response{Reason: "scanner input contains an empty requirement ID"})
			return
		}
		allowedIDs[id] = struct{}{}
	}
	for _, candidate := range input.Files {
		if candidate.Path == "" {
			writeResponse(response{Reason: "scanner input contains an empty source path"})
			return
		}
		baseline, err := base64.StdEncoding.DecodeString(candidate.Baseline)
		if err != nil {
			writeResponse(response{Reason: fmt.Sprintf("%s baseline is not base64: %v", candidate.Path, err)})
			return
		}
		current, err := base64.StdEncoding.DecodeString(candidate.Current)
		if err != nil {
			writeResponse(response{Reason: fmt.Sprintf("%s current is not base64: %v", candidate.Path, err)})
			return
		}
		baseline, err = stripCanonicalAnnotations(baseline, allowedIDs)
		if err != nil {
			writeResponse(response{Reason: fmt.Sprintf("%s baseline: %v", candidate.Path, err)})
			return
		}
		current, err = stripCanonicalAnnotations(current, allowedIDs)
		if err != nil {
			writeResponse(response{Reason: fmt.Sprintf("%s current: %v", candidate.Path, err)})
			return
		}
		if !bytes.Equal(baseline, current) {
			writeResponse(response{Reason: fmt.Sprintf("%s changes bytes beyond grounded trace annotations", candidate.Path)})
			return
		}
	}
	writeResponse(response{Allowed: true})
}

func writeResponse(value response) {
	_ = json.NewEncoder(os.Stdout).Encode(value)
}

// stripCanonicalAnnotations removes only complete, whitespace-delimited lines
// whose comment token is a supported canonical annotation and whose every ID
// is currently owned by the component. Everything else is retained byte for
// byte, including whitespace and comments that merely resemble annotations.
func stripCanonicalAnnotations(source []byte, allowedIDs map[string]struct{}) ([]byte, error) {
	var goScanner scanner.Scanner
	fileSet := token.NewFileSet()
	file := fileSet.AddFile("source.go", -1, len(source))
	var scanErr error
	goScanner.Init(file, source, func(_ token.Position, message string) {
		if scanErr == nil {
			scanErr = fmt.Errorf("%s", message)
		}
	}, scanner.ScanComments)

	var ranges [][2]int
	for {
		position, tokenKind, literal := goScanner.Scan()
		if tokenKind == token.EOF {
			break
		}
		if tokenKind != token.COMMENT || !strings.HasPrefix(literal, "//") {
			continue
		}
		start := file.Offset(position)
		end := start + len(literal)
		lineStart := start
		for lineStart > 0 && source[lineStart-1] != '\n' {
			lineStart--
		}
		lineEnd := end
		for lineEnd < len(source) && source[lineEnd] != '\n' {
			lineEnd++
		}
		if !onlyHorizontalWhitespace(source[lineStart:start]) ||
			!onlyHorizontalWhitespaceAndCR(source[end:lineEnd]) {
			continue
		}
		if !canonicalAnnotation(literal, allowedIDs) {
			continue
		}
		removeEnd := lineEnd
		if removeEnd < len(source) && source[removeEnd] == '\n' {
			removeEnd++
		}
		ranges = append(ranges, [2]int{lineStart, removeEnd})
	}
	if scanErr != nil {
		return nil, scanErr
	}
	if len(ranges) == 0 {
		return source, nil
	}
	result := make([]byte, 0, len(source))
	last := 0
	for _, span := range ranges {
		result = append(result, source[last:span[0]]...)
		last = span[1]
	}
	result = append(result, source[last:]...)
	return result, nil
}

func onlyHorizontalWhitespace(value []byte) bool {
	for _, character := range value {
		if character != ' ' && character != '\t' {
			return false
		}
	}
	return true
}

func onlyHorizontalWhitespaceAndCR(value []byte) bool {
	for _, character := range value {
		if character != ' ' && character != '\t' && character != '\r' {
			return false
		}
	}
	return true
}

func canonicalAnnotation(literal string, allowedIDs map[string]struct{}) bool {
	var value string
	for _, prefix := range annotationPrefixes {
		if strings.HasPrefix(literal, prefix) {
			value = strings.TrimSpace(literal[len(prefix):])
			break
		}
	}
	if value == "" {
		return false
	}
	for _, rawID := range strings.Split(value, ",") {
		id := strings.TrimSpace(rawID)
		if id == "" {
			return false
		}
		if _, ok := allowedIDs[id]; !ok {
			return false
		}
	}
	return true
}
