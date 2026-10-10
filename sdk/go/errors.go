package omniswitch

import (
	"encoding/json"
	"fmt"
	"strings"
)

// ApiError is thrown for every non-2xx OmniSwitch response, shaped
// {statusCode, error, code} (validation failures add a message array
// instead of error). Code is the stable, machine-readable field meant
// to be branched on; Message/Details are for logging, not
// string-matching.
type ApiError struct {
	StatusCode int
	Message    string
	Code       string
	Details    json.RawMessage
}

func (e *ApiError) Error() string {
	return fmt.Sprintf("OmniSwitchApiError(%d): %s", e.StatusCode, e.Message)
}

func newAPIErrorFromResponse(statusCode int, rawBody string) *ApiError {
	var body map[string]interface{}
	if rawBody != "" {
		_ = json.Unmarshal([]byte(rawBody), &body)
	}

	var message, code string
	if body != nil {
		if errVal, ok := body["error"].(string); ok {
			message = errVal
		} else if messageVal, ok := body["message"]; ok {
			switch m := messageVal.(type) {
			case []interface{}:
				parts := make([]string, 0, len(m))
				for _, item := range m {
					if s, ok := item.(string); ok {
						parts = append(parts, s)
					}
				}
				message = strings.Join(parts, "; ")
			case string:
				message = m
			}
		}
		if codeVal, ok := body["code"].(string); ok {
			code = codeVal
		}
	}

	if message == "" {
		message = fmt.Sprintf("OmniSwitch API request failed with HTTP %d", statusCode)
	}

	var details json.RawMessage
	if rawBody != "" {
		details = json.RawMessage(rawBody)
	}

	return &ApiError{StatusCode: statusCode, Message: message, Code: code, Details: details}
}
