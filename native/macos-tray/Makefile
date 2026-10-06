SHELL := /bin/bash
APP := build/Varro.app
CONTENTS := $(APP)/Contents
INSTALL_DIR ?= $(HOME)/Applications
DATA_DIR := $(HOME)/Library/Application Support/Varro/tray
ARCH ?= $(shell uname -m)
SWIFTC := xcrun swiftc
FLAGS := -swift-version 5 -warnings-as-errors -target $(ARCH)-apple-macosx13.0 -module-cache-path build/module-cache
SOURCES := $(wildcard Sources/*.swift)

.PHONY: build install run clean uninstall test test-layout test-indicator

build: build/.built

build/.built: $(SOURCES) Resources/Info.plist ../../assets/icon.png Makefile
	mkdir -p "$(CONTENTS)/MacOS" "$(CONTENTS)/Resources" build/Varro.iconset
	$(SWIFTC) $(FLAGS) -O -framework Cocoa -framework SwiftUI -framework ServiceManagement $(SOURCES) -o "$(CONTENTS)/MacOS/varro-tray"
	cp Resources/Info.plist "$(CONTENTS)/Info.plist"
	rm -f "$(CONTENTS)/Resources/VarroTemplate.png"
	@for size in 16 32 128 256 512; do \
		sips -z $$size $$size ../../assets/icon.png --out "build/Varro.iconset/icon_$${size}x$${size}.png" >/dev/null; \
		double=$$((size * 2)); \
		sips -z $$double $$double ../../assets/icon.png --out "build/Varro.iconset/icon_$${size}x$${size}@2x.png" >/dev/null; \
	done
	iconutil -c icns build/Varro.iconset -o "$(CONTENTS)/Resources/Varro.icns"
	codesign --force --sign - --timestamp=none "$(APP)"
	codesign --verify --deep --strict "$(APP)"
	touch "$@"

install: build
	@test ! -e "$(INSTALL_DIR)/Varro.app" || test "$$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$(INSTALL_DIR)/Varro.app/Contents/Info.plist")" = com.koltyakov.varro.tray
	mkdir -p "$(INSTALL_DIR)"
	ditto "$(APP)" "$(INSTALL_DIR)/Varro.app"
	@echo "Installed $(INSTALL_DIR)/Varro.app. Quit a running copy before reopening."

run: build
	open "$(APP)"

test: test-layout test-indicator
	mkdir -p build
	$(SWIFTC) $(FLAGS) -framework Foundation -framework Combine Sources/TrayModel.swift Sources/TrayServer.swift Tests/main.swift -o build/tray-tests
	build/tray-tests

test-layout:
	mkdir -p build
	$(SWIFTC) $(FLAGS) -framework Cocoa -framework SwiftUI -framework ServiceManagement Sources/TrayModel.swift Sources/TrayView.swift Tests/Layout/main.swift -o build/tray-layout-tests
	build/tray-layout-tests

test-indicator:
	mkdir -p build
	$(SWIFTC) $(FLAGS) -framework Cocoa -framework Combine Sources/TrayModel.swift Sources/TrayStatusIndicator.swift Tests/Indicator/main.swift -o build/tray-indicator-tests
	build/tray-indicator-tests

clean:
	rm -rf build

uninstall:
	@test ! -e "$(INSTALL_DIR)/Varro.app" || test "$$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$(INSTALL_DIR)/Varro.app/Contents/Info.plist")" = com.koltyakov.varro.tray
	rm -rf "$(INSTALL_DIR)/Varro.app"
	rm -rf "$(DATA_DIR)"
