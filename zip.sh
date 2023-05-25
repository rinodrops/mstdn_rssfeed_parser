#!/bin/sh

if [ -f "function.zip" ]; then
    rm function.zip
fi

zip -r function.zip .env index.js package-lock.json package.json node_modules
