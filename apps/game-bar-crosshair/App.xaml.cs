using Microsoft.Gaming.XboxGameBar;
using Windows.ApplicationModel.Activation;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Media;

namespace Xenon.Crosshair
{
    sealed partial class App : Application
    {
        private XboxGameBarWidget widget;
        private CrosshairPage page;

        public App()
        {
            InitializeComponent();
            Suspending += async (sender, args) =>
            {
                var deferral = args.SuspendingOperation.GetDeferral();
                var closing = page;
                page = null;
                widget = null;
                // Application suspension can run on a different view's UI thread.
                // Game Bar has already released its active widget connections here.
                try { if (closing != null) await closing.StopAsync(); }
                finally { deferral.Complete(); }
            };
        }

        protected override void OnActivated(IActivatedEventArgs args)
        {
            var activation = args as XboxGameBarWidgetActivatedEventArgs;
            if (activation == null || activation.AppExtensionId != "Crosshair") return;
            if (!activation.IsLaunchActivation) return;
            var frame = new Frame { Background = new SolidColorBrush(Windows.UI.Colors.Transparent) };
            Window.Current.Content = frame;
            widget = new XboxGameBarWidget(activation, Window.Current.CoreWindow, frame);
            var currentPage = new CrosshairPage(widget);
            page = currentPage;
            frame.Content = currentPage;
            Window.Current.Closed += async (sender, e) =>
            {
                await currentPage.StopAsync();
                if (ReferenceEquals(page, currentPage)) { page = null; widget = null; }
            };
            Window.Current.Activate();
        }

        protected override void OnLaunched(LaunchActivatedEventArgs args)
        {
            if (args.PrelaunchActivated) return;
            if (Window.Current.Content == null)
            {
                Window.Current.Content = new TextBlock
                {
                    Text = "Xenon Crosshair\n\nPress Win + G, open Widgets, then choose Xenon Crosshair.\nPin the widget and enable click-through in Game Bar.\n\nControls are also available in Xenon → System → FPS.",
                    Margin = new Thickness(32), FontSize = 20, TextWrapping = TextWrapping.Wrap
                };
            }
            Window.Current.Activate();
        }
    }
}
