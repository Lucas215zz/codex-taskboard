param(
    [Parameter(Mandatory = $true)][string]$App,
    [Parameter(Mandatory = $true)][int]$Port
)

$ErrorActionPreference = 'Stop'

# Launch the packaged (Microsoft Store) Codex with a CDP debugging port while
# keeping the DEFAULT user profile. That is what lets the Taskboard injector
# embed its panel into the Codex window you already use.

$source = @'
using System;
using System.Runtime.InteropServices;

[ComImport]
[Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager
{
    [PreserveSig]
    int ActivateApplication(
        [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [MarshalAs(UnmanagedType.LPWStr)] string arguments,
        uint options,
        out uint processId);
}

[ComImport]
[Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class ApplicationActivationManager {}

public static class PackagedAppActivator
{
    public static uint Activate(string appUserModelId, string arguments)
    {
        var manager = (IApplicationActivationManager)new ApplicationActivationManager();
        try
        {
            uint processId;
            var result = manager.ActivateApplication(appUserModelId, arguments, 0, out processId);
            if (result < 0) Marshal.ThrowExceptionForHR(result);
            return processId;
        }
        finally { Marshal.FinalReleaseComObject(manager); }
    }
}
'@

Add-Type -TypeDefinition $source

$package = Get-AppxPackage | Where-Object {
    $App.StartsWith(($_.InstallLocation + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)
} | Select-Object -First 1
if ($null -eq $package) { throw "Unable to find the Codex package for $App" }

$relativeExecutable = $App.Substring($package.InstallLocation.Length).TrimStart('\', '/').Replace('\', '/')
$manifest = $package | Get-AppxPackageManifest
$application = @($manifest.Package.Applications.Application) | Where-Object {
    ([string]$_.Executable).Replace('\', '/') -eq $relativeExecutable
} | Select-Object -First 1
if ($null -eq $application) { throw "Unable to find the Codex application manifest entry" }

$appUserModelId = $package.PackageFamilyName + '!' + $application.Id

# NOTE: no --user-data-dir on purpose. Same profile you use every day.
$arguments = '--remote-debugging-address=127.0.0.1' +
    ' --remote-debugging-port=' + $Port +
    ' --remote-allow-origins=http://127.0.0.1:' + $Port

$processId = [PackagedAppActivator]::Activate($appUserModelId, $arguments)
[Console]::Out.Write($processId)
