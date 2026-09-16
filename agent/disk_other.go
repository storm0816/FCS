//go:build !linux

package main

// The production Agent is Linux-only. Keeping this stub lets local Windows
// unit tests exercise the task logic without pretending a Windows free-space
// result is portable to the deployed Linux hosts.
func availableDiskSpace(_ string) (int64, error) { return 1 << 62, nil }
