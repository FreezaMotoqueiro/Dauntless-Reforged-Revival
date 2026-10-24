# DLSS and FSR on the Dauntless 1.14.7 client (optional)

Dauntless 1.14.7 has no DLSS, FSR or XeSS. This page adds DLSS 4 and FSR 3.1 to the **player client**
without touching the game files or the Reforged runtime's own proxy. It is optional and off until installed.

## How it works

| | |
| --- | --- |
| Game | Unreal Engine 4.26.2, DirectX 11 by default (`-dx12` also exists), TAA anti-aliasing |
| Upscaler | The [Luma Framework](https://github.com/Filoppi/Luma-Framework)'s *Unreal Engine* mod: a ReShade add-on that finds the game's TAA shader and replaces that pass with DLSS or FSR, using the game's own colour, depth, motion vectors and jitter |
| DLSS | NVIDIA RTX GPUs, `nvngx_dlss.dll` 310.x (DLSS 4 / 4.5 Super Resolution, transformer presets) |
| FSR | FSR 3.1 upscaler on DirectX 11, any GPU (AMD, Intel, NVIDIA GTX) |
| Loaded by | the Reforged runtime, patch 0041, on the client only |

This is the same idea as the Elden Ring mod ERSS: hook the game's temporal anti-aliasing pass and give its
inputs to a modern upscaler. ERSS is a DirectX 12 mod for FromSoftware's engine (proxy `dxgi.dll`, NVIDIA
Streamline, AMD FidelityFX SDK, Intel XeSS); Luma does the same on DirectX 11 for Unreal Engine 4, which is
what Dauntless is.

### Why it cannot conflict with the runtime

- The runtime is loaded by its proxy `winmm.dll`, which loads `MysticParadox.dll`. The upscaler uses neither name.
- On the client the runtime hooks game functions and a few `kernel32`/`user32`/`ws2_32` calls. It never hooks
  `d3d11.dll` or `dxgi.dll` there (its D3D11 hook exists only on a GPU-less server with `MP_FORCE_WARP.flag`).
  ReShade hooks only those two, so the two never patch the same function.
- Luma's package ships ReShade as `dxgi.dll`, a proxy that every process started from the folder would load,
  game servers included (the Director runs the same executable). The installer renames it to
  `ReShade64.dll`, which Windows never loads by itself, and the runtime loads it only in the client role
  (no `-server`, no `-nullrhi`), before the engine creates its D3D11 device.
- `DISABLE_UPSCALER.flag` beside the game executable turns it off without uninstalling.

## Install

Needs: the Reforged runtime with patch 0041 (the host's next runtime publish after this change) and the
launcher 1.5.2 or later (it updates itself).

1. Close the game.
2. Download [`upscaler/Install-Upscaler.ps1`](../upscaler/Install-Upscaler.ps1) and run, in PowerShell:

   ```powershell
   powershell -ExecutionPolicy Bypass -File Install-Upscaler.ps1 -GameDir C:\Dauntless
   ```

   It downloads the latest `Luma-Unreal_Engine.zip` from Luma's GitHub releases (or uses `-ZipPath`), copies
   it into `Archon\Binaries\Win64` with `dxgi.dll` renamed to `ReShade64.dll`, and lists every file in
   `reforged-upscaler.json`. It refuses to overwrite a file it did not install.
3. Start the game from the launcher. With the upscaler installed, the launcher writes
   `r.TemporalAA.Upsampling=1` (TAA then runs at the lower resolution and outputs at full resolution,
   which is the pass DLSS/FSR replaces) and keeps TAA as the anti-aliasing method. It no longer pins the
   resolution scale at 100 when a graphics level is forced.
4. In game, press **Home**: the ReShade and Luma menus open. Choose **DLSS** or **FSR** under Super Resolution.
5. Lower the resolution scale for more FPS (in game, or `sg.ResolutionQuality` in
   `%LOCALAPPDATA%\Archon\Saved\Config\WindowsClient\GameUserSettings.ini`):
   100 = DLAA / native AA, 67 = Quality, 58 = Balanced, 50 = Performance.

The runtime log (`mysticparadox_dll_port0.log` in the same folder) says `[Upscaler] ReShade64.dll loaded`.

Remove: `Install-Upscaler.ps1 -GameDir C:\Dauntless -Uninstall`.

## XeSS 2 and FSR 4 (next step, not done)

- **FSR 4** (Radeon RX 9000) and **XeSS 2** only exist for DirectX 12. On DirectX 11 the way there is
  [OptiScaler](https://github.com/optiscaler/OptiScaler), which takes the DLSS or FSR 3.1 calls Luma makes and
  runs FSR 4 or XeSS on a DirectX 12 device that shares textures with the game. It would load the same way
  (from the runtime, client only). Its usual proxy names collide here: `winmm.dll` is the runtime's loader and
  `dbghelp.dll` ships with the game; `dxgi.dll`, `version.dll` and `d3d12.dll` are free.
- **DirectX 12 mode** (`-dx12`) would allow DLSS Frame Generation and native FSR 4/XeSS, but Luma is
  DirectX 11 only. A DirectX 12 path needs its own hook of the engine's temporal upscaler
  (`r.TemporalAA.Upscaler` = `GTemporalUpscaler`, the interface UE 4.26's official DLSS/FSR plugins use),
  which is a much larger project.

## Limits

- The menus (Home key) come from ReShade with add-on support. ReShade's own effects are not needed.
- A game update or a different engine build could change the TAA shader; Luma finds it by its shape, not by
  a fixed hash, so it usually survives.
- Only the player client. Game servers never render.

---

## Português (Brasil)

O Dauntless 1.14.7 não tem DLSS nem FSR. O mod *Unreal Engine* do Luma Framework troca o TAA do jogo por
**DLSS 4** (placas RTX) ou **FSR 3.1** (qualquer placa) no DirectX 11. É o mesmo princípio do ERSS do Elden Ring.

- **Sem conflito com o runtime:** o runtime usa `winmm.dll` + `MysticParadox.dll` e não mexe em D3D11/DXGI no
  cliente. O ReShade do Luma é instalado como `ReShade64.dll` (não como `dxgi.dll`), e quem carrega é o runtime
  (patch 0041), só no cliente. Servidores nunca carregam.
- **Instalar:** feche o jogo e rode
  `powershell -ExecutionPolicy Bypass -File Install-Upscaler.ps1 -GameDir C:\Dauntless`.
  Precisa do runtime com o patch 0041 e do launcher 1.5.2.
- **Usar:** no jogo aperte **Home**, escolha DLSS ou FSR. Para ganhar FPS, baixe a escala de resolução
  (67 = Qualidade, 58 = Equilibrado, 50 = Desempenho). Em 100 vira DLAA.
- **Desligar:** crie `DISABLE_UPSCALER.flag` na pasta `Win64`. **Remover:** o mesmo script com `-Uninstall`.
- **XeSS 2 e FSR 4:** só existem no DirectX 12. O próximo passo é o OptiScaler por cima do Luma (ainda não feito).
