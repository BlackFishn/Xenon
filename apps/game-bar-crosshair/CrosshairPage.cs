
using System;
using System.IO;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Gaming.XboxGameBar;
using Windows.Data.Json;
using Windows.Graphics.Imaging;
using Windows.Storage;
using Windows.UI;
using Windows.UI.Core;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Media;
using Windows.UI.Xaml.Media.Imaging;
using Windows.UI.Xaml.Shapes;
using Path = System.IO.Path;
using FileAttributes = System.IO.FileAttributes;

namespace Xenon.Crosshair
{
    public sealed class CrosshairPage : Page
    {
        private const string CommandFile = "xenon-crosshair-command.json";
        private const string StatusFile = "xenon-crosshair-status.json";
        private readonly XboxGameBarWidget widget;
        private readonly CoreDispatcher uiDispatcher;
        private readonly DispatcherTimer timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(500) };
        private readonly Grid root = new Grid();
        private readonly Grid reticle = new Grid { Width = 132, Height = 132, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, IsHitTestVisible = false };
        private readonly Canvas drawing = new Canvas { Width = 132, Height = 132 };
        private readonly Image picture = new Image { Stretch = Stretch.Uniform, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        private readonly StackPanel controls = new StackPanel { Margin = new Thickness(16), VerticalAlignment = VerticalAlignment.Bottom, Spacing = 8 };
        private readonly TextBlock hint = new TextBlock { Margin = new Thickness(16), FontSize = 13, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Top };
        private readonly ToggleSwitch toggle = new ToggleSwitch { OnContent = "Crosshair on", OffContent = "Crosshair off" };
        private readonly Slider sizeSlider = new Slider { Minimum = 2, Maximum = 20, StepFrequency = 1, Width = 150, Header = "Length" };
        private readonly ComboBox colors = new ComboBox { Width = 120, Header = "Color" };
        private readonly string[] palette = { "#65F5BA", "#FFFFFF", "#FF5E74", "#4BCCFF", "#FFE66D" };
        private CrosshairSettings design = new CrosshairSettings();
        private bool enabled, busy, syncing, stopped, publishing, publishAgain;
        private string commandId = "", error = "", loadedAsset = "";
        private BitmapImage bitmap;
        private long lastStatus;

        public CrosshairPage(XboxGameBarWidget widget)
        {
            this.widget = widget;
            uiDispatcher = Window.Current.Dispatcher;
            Background = new SolidColorBrush(Colors.Transparent);
            Content = root;
            reticle.Children.Add(drawing);
            reticle.Children.Add(picture);
            root.Children.Add(reticle);
            root.Children.Add(hint);
            root.Children.Add(controls);
            LoadPreferences();
            var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12 };
            foreach (string value in palette) colors.Items.Add(value);
            row.Children.Add(colors);
            row.Children.Add(sizeSlider);
            var center = new Button { Content = "Center on this screen", HorizontalAlignment = HorizontalAlignment.Stretch };
            center.Click += async (s, e) => { await Center(); await Publish(); };
            controls.Children.Add(toggle);
            controls.Children.Add(row);
            controls.Children.Add(center);
            toggle.Toggled += async (s, e) =>
            {
                if (syncing || stopped) return;
                enabled = toggle.IsOn && (design.Mode != "image" || bitmap != null);
                Render(); await Publish();
            };
            colors.SelectionChanged += async (s, e) =>
            {
                if (syncing || stopped || colors.SelectedIndex < 0) return;
                design.Color = palette[colors.SelectedIndex]; SavePreferences(); Render(); await Publish();
            };
            sizeSlider.ValueChanged += async (s, e) =>
            {
                if (syncing || stopped) return;
                if (design.Mode == "image") design.ImageSize = (int)Math.Round(e.NewValue);
                else design.Length = (int)Math.Round(e.NewValue);
                SavePreferences(); Render(); await Publish();
            };
            widget.GameBarDisplayModeChanged += WidgetChanged;
            widget.PinnedChanged += WidgetChanged;
            widget.ClickThroughEnabledChanged += WidgetChanged;
            widget.VisibleChanged += WidgetChanged;
            timer.Tick += Tick;
            Loaded += async (s, e) =>
            {
                try { if (design.Mode == "image") await LoadImage(design.Asset); }
                catch (Exception) { error = "image_failed"; }
                Render(); await Center(); await Publish();
                if (!stopped && widget.Visible) timer.Start();
            };
        }

        private void LoadPreferences()
        {
            var values = ApplicationData.Current.LocalSettings.Values;
            try
            {
                if (values.TryGetValue("design", out object saved) && saved is string json && JsonObject.TryParse(json, out JsonObject parsed))
                    design = CrosshairSettings.Patch(design, parsed);
                else
                {
                    if (values.TryGetValue("color", out object color) && color is string text && Regex.IsMatch(text, "^#[0-9A-Fa-f]{6}$")) design.Color = text;
                    if (values.TryGetValue("size", out object size) && size is int n && n >= 8 && n <= 48)
                    {
                        design.Size = n; design.Length = Math.Max(2, Math.Min(20, n / 2)); design.Gap = 0;
                    }
                }
            }
            catch (Exception) { design = new CrosshairSettings(); }
            // Reopening starts OFF; saved designs never unexpectedly appear over a game.
        }

        private void SavePreferences()
        {
            try { ApplicationData.Current.LocalSettings.Values["design"] = design.ToJson().Stringify(); }
            catch (Exception) { /* Keep this session usable if Windows cannot persist preferences. */ }
        }

        private async Task LoadImage(string asset)
        {
            if (asset == loadedAsset && bitmap != null) return;
            if (!Regex.IsMatch(asset, "^[a-f0-9]{64}\\.(png|gif|jpg)$")) throw new InvalidDataException();
            string folder = Path.Combine(ApplicationData.Current.LocalFolder.Path, "crosshair-assets");
            string file = Path.Combine(folder, asset);
            if ((File.GetAttributes(folder) & FileAttributes.ReparsePoint) != 0 || (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException();
            long length = new FileInfo(file).Length;
            if (length <= 0 || length > 5 * 1024 * 1024) throw new InvalidDataException();
            byte[] bytes = File.ReadAllBytes(file);
            using (var hash = SHA256.Create())
                if (BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant() != asset.Substring(0, 64)) throw new InvalidDataException();
            using (var memory = new MemoryStream(bytes))
            using (var stream = memory.AsRandomAccessStream())
            {
                var decoder = await BitmapDecoder.CreateAsync(stream);
                if (decoder.PixelWidth == 0 || decoder.PixelHeight == 0 || decoder.PixelWidth > 2048 || decoder.PixelHeight > 2048
                    || decoder.FrameCount > 300 || (double)decoder.PixelWidth * decoder.PixelHeight * decoder.FrameCount > 64 * 1024 * 1024) throw new InvalidDataException();
                Guid codec = decoder.DecoderInformation.CodecId;
                if (codec != BitmapDecoder.PngDecoderId && codec != BitmapDecoder.GifDecoderId && codec != BitmapDecoder.JpegDecoderId) throw new InvalidDataException();
                stream.Seek(0);
                var next = new BitmapImage { AutoPlay = false };
                await next.SetSourceAsync(stream);
                if (stopped) return;
                bitmap?.Stop();
                bitmap = next; loadedAsset = asset; picture.Source = bitmap;
            }
        }

        private void Render()
        {
            if (stopped) return;
            bool foreground = widget.GameBarDisplayMode == XboxGameBarDisplayMode.Foreground;
            root.Background = new SolidColorBrush(foreground ? Color.FromArgb(255, 16, 24, 33) : Colors.Transparent);
            controls.Visibility = hint.Visibility = foreground ? Visibility.Visible : Visibility.Collapsed;
            hint.Text = error == "center_failed" ? "Could not center here. Move Game Bar to your game display and try Center again."
                : error == "image_failed" ? "This image could not be loaded. Choose another image in Xenon."
                : "Pin this widget and enable click-through.\nCustomize shapes, images and GIFs from the crosshair button in Xenon's side menu.";
            reticle.Visibility = enabled ? Visibility.Visible : Visibility.Collapsed;
            reticle.Opacity = 1;
            bool image = design.Mode == "image";
            drawing.Visibility = image ? Visibility.Collapsed : Visibility.Visible;
            picture.Visibility = image ? Visibility.Visible : Visibility.Collapsed;
            picture.Width = picture.Height = design.ImageSize;
            if (bitmap != null)
            {
                if (image && enabled && widget.Visible) bitmap.Play(); else bitmap.Stop();
            }
            drawing.Children.Clear();
            var brush = new SolidColorBrush(Color.FromArgb(255,
                Convert.ToByte(design.Color.Substring(1, 2), 16), Convert.ToByte(design.Color.Substring(3, 2), 16), Convert.ToByte(design.Color.Substring(5, 2), 16)));
            double border = design.Outline ? 1 : 0, thickness = design.Thickness, length = design.Length, gap = design.Gap;
            if (design.Shape == "dot") Dot(thickness / 2 + .5, brush, border);
            else if (design.Shape == "ring")
            {
                if (border > 0) Ring(length, thickness + 2, new SolidColorBrush(Colors.Black));
                Ring(length, thickness, brush);
            }
            else
            {
                Bar(-gap-length, -thickness/2, length, thickness, brush, border);
                Bar(gap, -thickness/2, length, thickness, brush, border);
                Bar(-thickness/2, gap, thickness, length, brush, border);
                if (design.Shape != "t") Bar(-thickness/2, -gap-length, thickness, length, brush, border);
            }
            if (design.CenterDot && design.Shape != "dot") Dot(Math.Max(1,thickness/2), brush, border);
            syncing = true;
            toggle.IsOn = enabled;
            toggle.IsEnabled = !image || bitmap != null;
            colors.IsEnabled = !image;
            sizeSlider.Minimum = image ? 8 : 2; sizeSlider.Maximum = image ? 128 : 20;
            sizeSlider.Header = image ? "Image size" : design.Shape == "ring" ? "Radius" : "Length";
            sizeSlider.Value = image ? design.ImageSize : design.Length;
            sizeSlider.IsEnabled = image || design.Shape != "dot";
            colors.PlaceholderText = design.Color;
            colors.SelectedIndex = Array.IndexOf(palette, design.Color);
            syncing = false;
        }

        private void RectangleAt(double x, double y, double width, double height, Brush fill)
        {
            var rect = new Rectangle { Width = width, Height = height, Fill = fill };
            Canvas.SetLeft(rect,66+x); Canvas.SetTop(rect,66+y); drawing.Children.Add(rect);
        }
        private void Bar(double x, double y, double width, double height, Brush fill, double border)
        {
            if (border > 0) RectangleAt(x-border,y-border,width+border*2,height+border*2,new SolidColorBrush(Colors.Black));
            RectangleAt(x,y,width,height,fill);
        }
        private void Dot(double radius, Brush fill, double border)
        {
            if (border > 0) Dot(radius+border,new SolidColorBrush(Colors.Black),0);
            var dot = new Ellipse { Width = radius*2, Height = radius*2, Fill = fill };
            Canvas.SetLeft(dot,66-radius); Canvas.SetTop(dot,66-radius); drawing.Children.Add(dot);
        }
        private void Ring(double radius, double thickness, Brush brush)
        {
            var ring = new Ellipse { Width = radius*2+thickness, Height = radius*2+thickness, Stroke = brush, StrokeThickness = thickness };
            Canvas.SetLeft(ring,66-radius-thickness/2); Canvas.SetTop(ring,66-radius-thickness/2); drawing.Children.Add(ring);
        }

        private async void WidgetChanged(XboxGameBarWidget sender, object args)
        {
            try
            {
                await uiDispatcher.RunAsync(CoreDispatcherPriority.Normal, async () =>
                {
                    if (stopped) return;
                    Render(); if (widget.Visible) timer.Start(); else timer.Stop();
                    await Publish();
                });
            }
            catch (Exception) { /* Game Bar may close the view before a queued event runs. */ }
        }

        private async Task Center()
        {
            try { await widget.CenterWindowAsync(); if (error == "center_failed") error = ""; }
            catch (Exception) { error = "center_failed"; }
            Render();
        }

        private async void Tick(object sender, object args)
        {
            if (busy || stopped || !widget.Visible) return;
            busy = true;
            try
            {
                string file = Path.Combine(ApplicationData.Current.LocalFolder.Path, CommandFile);
                if (File.Exists(file) && new FileInfo(file).Length <= 4096)
                {
                    if (JsonObject.TryParse(File.ReadAllText(file), out JsonObject command)) await ApplyCommand(command);
                }
                if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - lastStatus >= 2000) await Publish();
            }
            catch (Exception) { /* Invalid external data or a file lock must not terminate the overlay. */ }
            finally { busy = false; }
        }

        private async Task ApplyCommand(JsonObject command)
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            string id = command.GetNamedString("id", "");
            double expiry = command.GetNamedNumber("expiresAt", 0), version = command.GetNamedNumber("version", 0);
            if ((version != 1 && version != 2) || !Guid.TryParse(id,out _) || id == commandId
                || double.IsNaN(expiry) || expiry < now || expiry > now + 10000) return;
            CrosshairSettings next;
            bool nextEnabled = enabled, center = false;
            try
            {
                next = CrosshairSettings.Patch(design, command);
                if (command.ContainsKey("enabled")) nextEnabled = command["enabled"].GetBoolean();
                if (command.ContainsKey("center")) { center = command["center"].GetBoolean(); if (!center) throw new ArgumentException(); }
                if (version == 1 && command.ContainsKey("size")) { next.Mode = "draw"; next.Shape = "cross"; next.Length = Math.Max(2, Math.Min(20,next.Size/2)); next.Gap = 0; }
            }
            catch (Exception) { commandId = id; error = "invalid_settings"; await Publish(); return; }
            try { if (next.Mode == "image") await LoadImage(next.Asset); }
            catch (Exception) { commandId = id; error = "image_failed"; Render(); await Publish(); return; }
            if (stopped) return;
            design = next; enabled = nextEnabled; error = "";
            if (center) await Center();
            SavePreferences(); commandId = id; Render(); await Publish();
        }

        private async Task Publish()
        {
            if (stopped) return;
            if (publishing) { publishAgain = true; return; }
            publishing = true;
            try
            {
                do
                {
                    publishAgain = false;
                    var state = design.ToJson();
                    state["version"] = JsonValue.CreateNumberValue(2);
                    state["updatedAt"] = JsonValue.CreateNumberValue(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                    state["running"] = JsonValue.CreateBooleanValue(true);
                    state["enabled"] = JsonValue.CreateBooleanValue(enabled);
                    state["pinned"] = JsonValue.CreateBooleanValue(widget.Pinned);
                    state["visible"] = JsonValue.CreateBooleanValue(widget.Visible);
                    state["clickThrough"] = JsonValue.CreateBooleanValue(widget.ClickThroughEnabled);
                    state["commandId"] = JsonValue.CreateStringValue(commandId);
                    state["error"] = JsonValue.CreateStringValue(error);
                    StorageFile temp = await ApplicationData.Current.LocalFolder.CreateFileAsync(StatusFile + ".tmp", CreationCollisionOption.ReplaceExisting);
                    await FileIO.WriteTextAsync(temp,state.Stringify(),Windows.Storage.Streams.UnicodeEncoding.Utf8);
                    if (stopped) { await temp.DeleteAsync(); break; }
                    await temp.RenameAsync(StatusFile,NameCollisionOption.ReplaceExisting);
                    lastStatus = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                } while (publishAgain && !stopped);
            }
            catch (Exception) { /* The desktop reports offline when the heartbeat expires. */ }
            finally { publishing = false; }
        }

        public async Task StopAsync()
        {
            try
            {
                if (uiDispatcher.HasThreadAccess) Stop();
                else await uiDispatcher.RunAsync(CoreDispatcherPriority.Normal,Stop);
            }
            catch (Exception) { /* The last widget view may already be gone during suspension. */ }
        }

        private void Stop()
        {
            if (stopped) return;
            stopped = true; timer.Stop(); bitmap?.Stop();
            widget.GameBarDisplayModeChanged -= WidgetChanged;
            widget.PinnedChanged -= WidgetChanged;
            widget.ClickThroughEnabledChanged -= WidgetChanged;
            widget.VisibleChanged -= WidgetChanged;
            try { File.Delete(Path.Combine(ApplicationData.Current.LocalFolder.Path,StatusFile)); }
            catch (Exception) { /* A terminated widget also expires through its heartbeat. */ }
        }
    }
}
