import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";

const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$path = [Console]::In.ReadToEnd() | ConvertFrom-Json
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($owner)
$acl.SetAccessRuleProtection($true, $false)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($owner, 'FullControl',
  [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl -ErrorAction Stop
`;

/** JSON input keeps installation paths out of PowerShell source. No administrator rights. */
export async function protectWindowsEngineDirectory(directory: string): Promise<void> {
  const system = process.env.SystemRoot;
  if (!system || !isAbsolute(system)) throw new Error("Windows system directory is unavailable");
  await new Promise<void>((resolve, reject) => {
    const child = execFile(join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
      { timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 }, error => {
        if (error) reject(new Error("Engine installation could not secure its private directory")); else resolve();
      });
    child.stdin?.end(JSON.stringify(directory));
  });
}
