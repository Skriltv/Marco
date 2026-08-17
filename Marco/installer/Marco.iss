; Marco installer — Inno Setup script
;
; Build the app first, then compile this:
;   1. pnpm install               (once)
;   2. pnpm tauri build --no-bundle     <- compiles src-tauri\target\release\marco.exe
;                                          without also invoking Tauri's own NSIS bundler
;   3. ISCC installer\Marco.iss          <- produces the setup exe
;
; Output lands in installer\output\Marco_<version>_x64-setup.exe, matching the
; naming Polo and Marshal already use.
;
; Requires Inno Setup 6+ (https://jrsoftware.org/isinfo.php). If you compile
; from the Inno Setup IDE instead of the command line, just open this file
; and hit Build > Compile.

#define MyAppName "Marco"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Marco"
#define MyAppExeName "marco.exe"

; Fixed AppId — do NOT change this between releases, or Windows will treat
; upgrades as a separate app (no in-place update, duplicate Start Menu entries).
#define MyAppId "{{BF49E08A-8767-4AE4-9FF6-D64761293438}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=output
OutputBaseFilename={#MyAppName}_{#MyAppVersion}_x64-setup
SetupIconFile=..\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
PrivilegesRequired=lowest

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
; The compiled binary — see the header comment for the build command that produces this.
Source: "..\src-tauri\target\release\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent
