# DLSS, FSR 4 and XeSS on the Dauntless 1.14.7 client

Dauntless 1.14.7 has no DLSS, FSR or XeSS. The launcher (1.5.3 or later) installs them beside the **player
client** before each launch, without touching the game files or the Reforged runtime's own proxy. It is on by
default and can be turned off in **Settings > Graphics**.

## How it works

| | |
| --- | --- |
| Game | Unreal Engine 4.26.2, DirectX 11 by default (`-dx12` also exists), TAA anti-aliasing |
| Luma | The [Luma Framework](https://github.com/Filoppi/Luma-Framework)'s *Unreal Engine* mod (build 761): a ReShade add-on that finds the game's TAA shader and replaces that pass with DLSS, using the game's own colour, depth, motion vectors and jitter. Ships DLSS 310.9.16 (DLSS 4.5 Super Resolution, the newest) and FSR 3.1 |
| OptiScaler | [OptiScaler](https://github.com/optiscaler/OptiScaler) 0.9.4: takes Luma's DLSS calls and runs **FSR 4.1.1** (FidelityFX SDK 2.3; Radeon RX 9000 and RX 7000, FSR 3.1 on other GPUs), **XeSS 3.0.1** or **DLSS**, through a background DirectX 12 device that shares the game's textures. It detects Luma and sets itself up for it |
| First upscaler | NVIDIA: DLSS. AMD and others: FSR 3.1/4 (`fsr31_12`). Intel: XeSS (`xess_12`). Changed in game with **Insert** |
| Loaded by | the Reforged runtime, patches 0041/0043, on the client only |

This is the same idea as the Elden Ring mod ERSS: hook the game's temporal anti-aliasing pass and give its
inputs to a modern upscaler. ERSS is a DirectX 12 mod for FromSoftware's engine (proxy `dxgi.dll`, NVIDIA
Streamline, AMD FidelityFX SDK, Intel XeSS); Luma does the same on DirectX 11 for Unreal Engine 4, which is
what Dauntless is, and OptiScaler adds the DirectX 12-only upscalers (FSR 4, XeSS) on top.

### Why it cannot conflict with the runtime

- The runtime is loaded by its proxy `winmm.dll`, which loads `MysticParadox.dll`. The upscaler uses neither name.
- On the client the runtime hooks game functions and a few `kernel32`/`user32`/`ws2_32` calls. It never hooks
  `d3d11.dll` or `dxgi.dll` there (its D3D11 hook exists only on a GPU-less server with `MP_FORCE_WARP.flag`).
  ReShade hooks only those two, so the two never patch the same function.
- Luma's package ships ReShade as `dxgi.dll`, a proxy that every process started from the folder would load,
  game servers included (the Director runs the same executable). The installer renames it to
  `ReShade64.dll`, which Windows never loads by itself, and the runtime loads it only in the client role
  (no `-server`, no `-nullrhi`), before the engine creates its D3D11 device.
- OptiScaler is installed under its non-proxy name `OptiScaler.dll` (never `dxgi.dll`, `winmm.dll`, `version.dll`...).
  The runtime loads it instead of ReShade when it is there (patch 0043), and OptiScaler loads `ReShade64.dll` itself
  (`LoadReshade=true` in `OptiScaler.ini`), after the DirectX 12 device it creates for Luma. If it fails to load, the
  runtime loads ReShade alone. `DISABLE_OPTISCALER.flag` keeps Luma alone (DLSS on NVIDIA, FSR 3.1 elsewhere).
- `DISABLE_UPSCALER.flag` beside the game executable turns everything off without uninstalling (the launcher's
  switch writes it).
- ReShade loaded under a non-proxy name only starts when `ReShade.ini` exists beside the game executable (otherwise
  its `DllMain` refuses to load). The installer creates a minimal one; deleting it also turns the upscaler off.
- The game ships the VC++ 14.24 runtime beside its executable; Luma needs a current one ("custom version of
  msvcp140.dll" warning). The installer moves those 8 DLLs to `reforged-vcrt-backup\` so the system's VC++ 2015-2022
  redistributable is used (the launcher already requires it); `-Uninstall` puts them back.

## Install (automatic)

Needs the Reforged runtime with patch 0043 (the host's next runtime publish after this change; with only 0041
the upscaler still works, as Luma alone) and the VC++ 2015-2022 x64 redistributable (the launcher asks for it).

1. Press Play. Before the game starts, the launcher downloads the upscaler pack (about 215 MB, once; later only
   changed files) and puts it in `Archon\Binaries\Win64`:
   - every file comes from the release [`upscaler-<id>`](https://github.com/FreezaMotoqueiro/Dauntless-Reforged-Revival/releases)
     of this repository, named by its SHA-256, and is kept only when its hash is the one compiled into the launcher
     ([`upscaler-pack.json`](../ReforgedLauncher/src/main/upscaler-pack.json), made by [`upscaler/pack.mjs`](../upscaler/pack.mjs)
     from the pinned upstream archives; the [Upscaler pack](../.github/workflows/upscaler-pack.yml) workflow publishes it);
   - `OptiScaler.ini` is written once with `LoadReshade=true` and the first upscaler for your GPU, then left to you;
   - `ReShade.ini` is created if missing; the game's old VC++ 14.24 DLLs are moved to `reforged-vcrt-backup\`;
   - Luma's HDR (`[Luma] EnableHDR` in `ReShade.ini`) is set once to match Windows HDR: off on an SDR display, where it
     gains nothing and makes OptiScaler's menu look washed out. A choice made in Luma's menu is kept;
   - a file it did not install is never overwritten; `reforged-upscaler.json` lists what it installed.
   A failed download never stops the launch: the game starts as it is and the launcher tries again next time.
2. The launcher writes `r.TemporalAA.Upsampling=1` and the mode's resolution scale (see below).
3. In game:
   - **Insert** opens OptiScaler: pick the upscaler (FSR 4 / FSR 3.1 = `FSR 3.X w/Dx12`, XeSS, DLSS), sharpening (RCAS),
     DLSS presets. OptiScaler shows `FSR 4` in its overlay when FSR 4 is active.
   - **Home** opens ReShade and Luma: keep **Super Resolution** on **DLSS** or **Auto**. That is the input OptiScaler
     replaces; Luma's own FSR 3 bypasses OptiScaler.
4. Pick the mode in the launcher, **Settings > Graphics > DLSS / FSR mode**. Luma has no mode menu of its own: the
   mode is the game's render resolution, which the launcher writes as `r.ScreenPercentage`: Native (DLAA) = 100,
   Ultra Quality = 77, Quality = 67 (default), Balanced = 58, Performance = 50, Ultra Performance = 33.
   The launcher rounds the mode to the nearest scale whose render size has exactly your resolution's aspect ratio
   (1080p Quality = 1280x720, `r.ScreenPercentage=66.666167`): Luma skips DLSS when the two differ even slightly,
   which 67% of 1920x1080 (1287x724) did. "Game's resolution scale" leaves it to the in-game setting (or `sg.ResolutionQuality` in
   `%LOCALAPPDATA%\Archon\Saved\Config\WindowsClient\GameUserSettings.ini`). Keep dynamic resolution off.

The runtime log (`mysticparadox_dll_port0.log`) says `[Upscaler] OptiScaler.dll loaded`; OptiScaler writes
`OptiScaler.log` and ReShade `ReShade.log` in the same folder. The launcher's log says what it installed.

Turn off: **Settings > Graphics > Upscaler**. Remove everything: `upscaler/Install-Upscaler.ps1 -GameDir C:\Dauntless -Uninstall`
(it reads the same `reforged-upscaler.json`) with the switch off, or the launcher installs it again.

### Manual install (Luma only)

[`upscaler/Install-Upscaler.ps1`](../upscaler/Install-Upscaler.ps1) installs the latest Luma release by hand
(`powershell -ExecutionPolicy Bypass -File Install-Upscaler.ps1 -GameDir C:\Dauntless`), without OptiScaler. The
launcher takes over such an install and updates it.

## Next steps (not done)

- **Frame generation**: OptiScaler's frame generation (OptiFG, FSR-FG, XeFG) is DirectX 12 only in 0.9.4; the game runs
  DirectX 11. Its next version adds DirectX 11 frame generation from upscaler inputs.
- **DirectX 12 mode** (`-dx12`) would allow DLSS Frame Generation and native FSR 4/XeSS, but Luma is DirectX 11
  only. A DirectX 12 path needs its own hook of the engine's temporal upscaler (`r.TemporalAA.Upscaler` =
  `GTemporalUpscaler`, the interface UE 4.26's official DLSS/FSR plugins use), which is a much larger project.
- **FSR 4 on Radeon RX 6000 and older**: OptiScaler's `Fsr4ForceEnableInt8` with an FSR 4.0.2 INT8 build, not bundled.

## Limits

- The menus (Home key) come from ReShade with add-on support. ReShade's own effects are not needed.
- A game update or a different engine build could change the TAA shader; Luma finds it by its shape, not by
  a fixed hash, so it usually survives.
- Only the player client. Game servers never render.

---

## Português (Brasil)

O Dauntless 1.14.7 não tem DLSS, FSR nem XeSS. O launcher (1.5.3 ou mais novo) instala tudo sozinho antes de abrir o
jogo, só no **cliente**. Vem ligado e pode ser desligado em **Configurações > Gráficos**.

- **O que é instalado:** o mod *Unreal Engine* do Luma (build 761, com DLSS 310.9.16, o mais recente) troca o TAA do jogo
  por DLSS. O **OptiScaler 0.9.4** recebe essas chamadas e roda **FSR 4.1.1** (Radeon RX 9000 e RX 7000; FSR 3.1 nas
  outras), **XeSS 3.0.1** ou **DLSS**, via DirectX 12. Primeiro upscaler: NVIDIA = DLSS, AMD = FSR 3.1/4, Intel = XeSS.
- **Sem conflito com o runtime:** o runtime usa `winmm.dll` + `MysticParadox.dll` e não mexe em D3D11/DXGI no cliente.
  O OptiScaler é instalado como `OptiScaler.dll` e o ReShade como `ReShade64.dll` (nenhum é nome de proxy). Quem carrega é o
  runtime (patch 0043), só no cliente. Servidores nunca carregam.
- **Download:** cerca de 215 MB na primeira vez, de uma release deste repositório. Cada arquivo é conferido pelo SHA-256
  fixo no launcher. Se falhar, o jogo abre mesmo assim e o launcher tenta de novo na próxima vez.
- **No jogo:** **Insert** abre o OptiScaler (escolha FSR 4 / FSR 3.1 = `FSR 3.X w/Dx12`, XeSS ou DLSS). **Home** abre o Luma:
  deixe **Super Resolution** em **DLSS** ou **Auto** (é a entrada que o OptiScaler troca).
- **Modo:** Configurações > Gráficos > Modo do DLSS / FSR (Nativo/DLAA, Ultra Qualidade, Qualidade, Equilibrado, Desempenho,
  Ultra Desempenho). O modo é a resolução interna do jogo (`r.ScreenPercentage`).
- **HDR do Luma:** o launcher deixa desligado se o HDR do Windows estiver desligado (com ele ligado, o menu do OptiScaler fica desbotado). A escolha feita no menu do Luma é mantida.
- **Escala exata:** o launcher arredonda o modo para uma escala com a mesma proporção exata da sua resolução (1080p Qualidade = 1280x720). Com proporção diferente, mesmo por um pixel, o Luma não chama o DLSS. Na opção "Escala de resolução do jogo", use 50% ou 75%.
- **Desligar:** a chave em Configurações > Gráficos (cria `DISABLE_UPSCALER.flag`). `DISABLE_OPTISCALER.flag` deixa só o Luma.
- **Precisa:** runtime com o patch 0043 e o VC++ 2015-2022 x64.
