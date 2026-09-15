using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Gaming.XboxGameBar;
using Windows.Data.Json;
using Windows.Storage;
using Windows.UI;
using Windows.UI.Core;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Media;
using Rectangle = Windows.UI.Xaml.Shapes.Rectangle;

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
        private readonly Grid reticle = new Grid { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, IsHitTestVisible = false };
        private readonly StackPanel controls = new StackPanel { Margin = new Thickness(16), VerticalAlignment = VerticalAlignment.Bottom, Spacing = 8 };
        private readonly TextBlock hint = new TextBlock { Margin = new Thickness(16), FontSize = 13, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Top };
        private readonly ToggleSwitch toggle = new ToggleSwitch { OnContent = "Crosshair on", OffContent = "Crosshair off" };
        private readonly Slider sizeSlider = new Slider { Minimum = 8, Maximum = 48, StepFrequency = 1, Width = 150, Header = "Size" };
        private readonly ComboBox colors = new ComboBox { Width = 120, Header = "Color" };
        private readonly string[] palette = { "#65F5BA", "#FFFFFF", "#FF5E74", "#4BCCFF", "#FFE66D" };
        private bool enabled;
        private string color = "#65F5BA";
        private int size = 20;
        private string commandId = "";
        private string error = "";
        private bool busy, syncing, stopped;
        private long lastStatus;

        public CrosshairPage(XboxGameBarWidget widget)
        {
            this.widget = widget;
            uiDispatcher = Window.Current.Dispatcher;
            Background = new SolidColorBrush(Colors.Transparent);
            Content = root;
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
            toggle.Toggled += async (s, e) => { if (!syncing) { enabled = toggle.IsOn; Render(); await Publish(); } };
            colors.SelectionChanged += async (s, e) =>
            {
                if (syncing || colors.SelectedIndex < 0) return;
                color = palette[colors.SelectedIndex]; SavePreferences(); Render(); await Publish();
            };
            sizeSlider.ValueChanged += async (s, e) =>
            {
                if (syncing) return;
                size = (int)Math.Round(e.NewValue); SavePreferences(); Render(); await Publish();
            };
            widget.GameBarDisplayModeChanged += WidgetChanged;
            widget.PinnedChanged += WidgetChanged;
            widget.ClickThroughEnabledChanged += WidgetChanged;
            widget.VisibleChanged += WidgetChanged;
            timer.Tick += Tick;
            Loaded += async (s, e) => { Render(); await Center(); await Publish(); if (!stopped && widget.Visible) timer.Start(); };
        }

        private void LoadPreferences()
        {
            var settings = ApplicationData.Current.LocalSettings.Values;
            if (settings.TryGetValue("color", out object savedColor) && savedColor is string text && Regex.IsMatch(text, "^#[0-9A-Fa-f]{6}$")) color = text;
            if (settings.TryGetValue("size", out object savedSize) && savedSize is int value && value >= 8 && value <= 48) size = value;
            // Visibility is session state: reopening the widget starts with the toggle off.
        }

        private void SavePreferences()
        {
            ApplicationData.Current.LocalSettings.Values["color"] = color;
            ApplicationData.Current.LocalSettings.Values["size"] = size;
        }

        private void Render()
        {
            if (stopped) return;
            bool foreground = widget.GameBarDisplayMode == XboxGameBarDisplayMode.Foreground;
            root.Background = new SolidColorBrush(foreground ? Color.FromArgb(255, 16, 24, 33) : Colors.Transparent);
            controls.Visibility = hint.Visibility = foreground ? Visibility.Visible : Visibility.Collapsed;
            hint.Text = error == "center_failed" ? "Could not center here. Move Game Bar to your game display and try Center again."
                : "Pin this widget, then enable click-through in Game Bar.\nUse Xenon → System → FPS to control it while playing.";
            reticle.Visibility = enabled ? Visibility.Visible : Visibility.Collapsed;
            // Keep the aim point legible independently of Game Bar panel transparency.
            reticle.Opacity = 1;
            reticle.Width = reticle.Height = size + 2;
            reticle.Children.Clear();
            var brush = new SolidColorBrush(Color.FromArgb(255,
                Convert.ToByte(color.Substring(1, 2), 16), Convert.ToByte(color.Substring(3, 2), 16), Convert.ToByte(color.Substring(5, 2), 16)));
            AddBar(size + 2, 4, new SolidColorBrush(Colors.Black));
            AddBar(4, size + 2, new SolidColorBrush(Colors.Black));
            AddBar(size, 2, brush);
            AddBar(2, size, brush);
            syncing = true;
            toggle.IsOn = enabled;
            sizeSlider.Value = size;
            colors.SelectedIndex = Array.IndexOf(palette, color);
            syncing = false;
        }

        private void AddBar(double width, double height, Brush fill)
        {
            reticle.Children.Add(new Rectangle { Width = width, Height = height, Fill = fill,
                HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center });
        }

        private async void WidgetChanged(XboxGameBarWidget sender, object args)
        {
            try
            {
                await uiDispatcher.RunAsync(CoreDispatcherPriority.Normal, async () =>
                {
                    if (stopped) return;
                    Render();
                    if (widget.Visible) timer.Start(); else timer.Stop();
                    await Publish();
                });
            }
            catch (Exception) { /* Game Bar may close the CoreWindow before a queued event runs. */ }
        }

        private async Task Center()
        {
            try { await widget.CenterWindowAsync(); error = ""; }
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
                    string text = File.ReadAllText(file);
                    if (JsonObject.TryParse(text, out JsonObject command)) await ApplyCommand(command);
                }
                if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - lastStatus >= 2000) await Publish();
            }
            catch (IOException) { /* An atomic desktop write may briefly hold the file; retry next tick. */ }
            catch (UnauthorizedAccessException) { }
            catch (Exception) { /* Invalid external data cannot terminate the overlay. */ }
            finally { busy = false; }
        }

        private async Task ApplyCommand(JsonObject command)
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            string id = command.GetNamedString("id", "");
            double expiry = command.GetNamedNumber("expiresAt", 0);
            if (command.GetNamedNumber("version", 0) != 1 || !Guid.TryParse(id, out _) || id == commandId || expiry < now || expiry > now + 10000) return;
            foreach (string key in command.Keys)
                if (key != "id" && key != "version" && key != "expiresAt" && key != "enabled" && key != "color" && key != "size" && key != "center") return;
            bool nextEnabled = enabled;
            string nextColor = color;
            int nextSize = size;
            if (command.ContainsKey("enabled"))
            {
                if (command["enabled"].ValueType != JsonValueType.Boolean) return;
                nextEnabled = command["enabled"].GetBoolean();
            }
            if (command.ContainsKey("color"))
            {
                if (command["color"].ValueType != JsonValueType.String) return;
                nextColor = command["color"].GetString();
                if (!Regex.IsMatch(nextColor, "^#[0-9A-Fa-f]{6}$")) return;
            }
            if (command.ContainsKey("size"))
            {
                if (command["size"].ValueType != JsonValueType.Number) return;
                double value = command["size"].GetNumber();
                if (double.IsNaN(value) || value < 8 || value > 48 || value != Math.Round(value)) return;
                nextSize = (int)value;
            }
            if (command.ContainsKey("center") && (command["center"].ValueType != JsonValueType.Boolean || !command["center"].GetBoolean())) return;
            enabled = nextEnabled; color = nextColor.ToUpperInvariant(); size = nextSize;
            error = "";
            if (command.ContainsKey("center")) await Center();
            SavePreferences();
            commandId = id;
            Render();
            await Publish();
        }

        private bool publishing;
        private async Task Publish()
        {
            if (publishing || stopped) return;
            publishing = true;
            try
            {
                var state = new JsonObject
                {
                    ["version"] = JsonValue.CreateNumberValue(1),
                    ["updatedAt"] = JsonValue.CreateNumberValue(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()),
                    ["running"] = JsonValue.CreateBooleanValue(true),
                    ["enabled"] = JsonValue.CreateBooleanValue(enabled),
                    ["color"] = JsonValue.CreateStringValue(color),
                    ["size"] = JsonValue.CreateNumberValue(size),
                    ["pinned"] = JsonValue.CreateBooleanValue(widget.Pinned),
                    ["visible"] = JsonValue.CreateBooleanValue(widget.Visible),
                    ["clickThrough"] = JsonValue.CreateBooleanValue(widget.ClickThroughEnabled),
                    ["commandId"] = JsonValue.CreateStringValue(commandId),
                    ["error"] = JsonValue.CreateStringValue(error)
                };
                StorageFile temp = await ApplicationData.Current.LocalFolder.CreateFileAsync(StatusFile + ".tmp", CreationCollisionOption.ReplaceExisting);
                await FileIO.WriteTextAsync(temp, state.Stringify(), Windows.Storage.Streams.UnicodeEncoding.Utf8);
                await temp.RenameAsync(StatusFile, NameCollisionOption.ReplaceExisting);
                lastStatus = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }
            catch (Exception) { /* A failed heartbeat is reported offline by the desktop controller. */ }
            finally { publishing = false; }
        }

        public async Task StopAsync()
        {
            try
            {
                if (uiDispatcher.HasThreadAccess) Stop();
                else await uiDispatcher.RunAsync(CoreDispatcherPriority.Normal, Stop);
            }
            catch (Exception) { /* The last widget CoreWindow may already be gone during suspension. */ }
        }

        private void Stop()
        {
            if (stopped) return;
            stopped = true;
            timer.Stop();
            widget.GameBarDisplayModeChanged -= WidgetChanged;
            widget.PinnedChanged -= WidgetChanged;
            widget.ClickThroughEnabledChanged -= WidgetChanged;
            widget.VisibleChanged -= WidgetChanged;
            try { File.Delete(Path.Combine(ApplicationData.Current.LocalFolder.Path, StatusFile)); }
            catch (Exception) { /* A terminated widget also becomes offline after its heartbeat expires. */ }
        }
    }
}
