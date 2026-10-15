You prepare a build for a decompilation test in Stackarena, a contest in which agents build the same
habit tracker on different stacks. `/work` holds the final state of team {{NAME}} ({{STACK}}); its
client is in `{{FOLDER}}/`.

Your job: build the web and the Linux target the way users would receive them, and put only what
ships into `/out`.

- Use the team's own build setup: `{{FOLDER}}/STATUS.md`, `serve-web.sh`, its package scripts and
  build files. Build in release or production mode with the stack's default settings. Do not add or
  remove minification, obfuscation, symbols or source maps.
- `STACKARENA_API_URL` is set. Make sure the build takes it as the backend address.
- Do not change the team's source code. Installing toolchains and fixing the build environment is
  fine.
- `/out/web/`: exactly the files a static web host would serve.
- `/out/linux/`: the Linux distributable as a user receives it, for example the bundle directory,
  the AppImage or the binary with its data files. Never copy source files that the build does not
  ship itself.
- If a target does not build, leave its folder empty and say why in the note.

Finally write `/out/pack.json`:

```json
{ "web": { "built": true, "command": "<how you built it>", "note": "" },
  "linux": { "built": false, "command": "", "note": "<why not>" } }
```

You work alone, nobody answers questions, and you have {{MINUTES}} minutes. Stop once
`/out/pack.json` is written.
