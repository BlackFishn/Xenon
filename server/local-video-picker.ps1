param([ValidateSet('Videos', 'Subtitle')][string]$Kind = 'Videos')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.CheckFileExists = $true
$dialog.CheckPathExists = $true
$dialog.RestoreDirectory = $true
$dialog.Multiselect = $Kind -eq 'Videos'
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
if ($Kind -eq 'Videos') {
  $dialog.Title = 'Open videos in Xenon'
  $dialog.Filter = 'Video files|*.mkv;*.mp4;*.m4v;*.mov;*.webm;*.avi'
} else {
  $dialog.Title = 'Open subtitles in Xenon'
  $dialog.Filter = 'Subtitle files|*.srt;*.ass;*.ssa;*.vtt'
}
try {
  $owner.Show()
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    ConvertTo-Json -InputObject @($dialog.FileNames) -Compress
  } else {
    '[]'
  }
} finally {
  $dialog.Dispose()
  $owner.Dispose()
}
