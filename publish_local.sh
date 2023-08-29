#!/usr/bin/env bash

DIR=~/gd/_map/.obsidian/plugins/mapper

mkdir -p $DIR
cp main.js $DIR/main.js
cp manifest.json $DIR/manifest.json
cp styles.css $DIR/styles.css
echo "Published to: $DIR"