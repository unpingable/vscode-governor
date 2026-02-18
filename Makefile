SHELL := /bin/bash
PM ?= npm

.PHONY: test lint build ci package

test:
	$(PM) test

lint:
	$(PM) run -s lint

build:
	$(PM) run -s build

package:
	$(PM) run -s package

ci: lint test build
