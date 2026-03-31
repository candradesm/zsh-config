# Kotlin LSP Configuration Issue

**Date:** 2025-03-29
**Status:** ✅ FIXED

## Problem Summary

The Kotlin Language Server (KLS) was crashing with:
```
Expected BEGIN_OBJECT but was BEGIN_ARRAY at path $
```

## RootCause

Found in [nvim-lspconfig#3239](https://github.com/neovim/nvim-lspconfig/issues/3239):

1. `nvim-lspconfig` sets `init_options.storagePath = vim.fs.root(...)`
2. `vim.fs.root()` can return `nil` when no project root is found
3. When `storagePath` is `nil`, KLS tries to parse it and crashes

## Solution

Set `storagePath` to a valid cache path:

```lua
init_options = {
  storagePath = vim.fn.resolve(vim.fn.stdpath("cache") .. "/kotlin_language_server"),
}
```

## Files Modified

1. `/Users/cristianpc/.config/nvim/lua/plugins/kotlin.lua` - Fixed init_options

## Testing

```vim
" Restart Neovim, then:
:LspInfo
```

Should show `kotlin_language_server` attached when opening `.kt` files.

## References

- [nvim-lspconfig#3239](https://github.com/neovim/nvim-lspconfig/issues/3239)
- [kotlin-language-server#546](https://github.com/fwcd/kotlin-language-server/issues/546)