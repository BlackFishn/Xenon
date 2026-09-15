
using System;
using System.Text.RegularExpressions;
using Windows.Data.Json;

namespace Xenon.Crosshair
{
    internal sealed class CrosshairSettings
    {
        public string Mode = "draw", Shape = "cross", Color = "#65F5BA", Asset = "", AssetName = "";
        public int Size = 20, Length = 8, Thickness = 2, Gap = 4, ImageSize = 64;
        public bool Outline = true, CenterDot;
        public CrosshairSettings Clone() => (CrosshairSettings)MemberwiseClone();
        public JsonObject ToJson() => new JsonObject
        {
            ["mode"] = JsonValue.CreateStringValue(Mode), ["shape"] = JsonValue.CreateStringValue(Shape),
            ["color"] = JsonValue.CreateStringValue(Color), ["size"] = JsonValue.CreateNumberValue(Size),
            ["length"] = JsonValue.CreateNumberValue(Length), ["thickness"] = JsonValue.CreateNumberValue(Thickness),
            ["gap"] = JsonValue.CreateNumberValue(Gap), ["outline"] = JsonValue.CreateBooleanValue(Outline),
            ["centerDot"] = JsonValue.CreateBooleanValue(CenterDot), ["imageSize"] = JsonValue.CreateNumberValue(ImageSize),
            ["asset"] = Asset == "" ? JsonValue.CreateNullValue() : JsonValue.CreateStringValue(Asset),
            ["assetName"] = JsonValue.CreateStringValue(AssetName)
        };
        private static int Number(IJsonValue value, int min, int max)
        {
            if (value.ValueType != JsonValueType.Number) throw new ArgumentException();
            double n = value.GetNumber();
            if (double.IsNaN(n) || double.IsInfinity(n) || n < min || n > max || n != Math.Round(n)) throw new ArgumentException();
            return (int)n;
        }
        public static CrosshairSettings Patch(CrosshairSettings current, JsonObject patch)
        {
            var result = current.Clone();
            foreach (var item in patch)
            {
                switch (item.Key)
                {
                    case "mode": result.Mode = item.Value.GetString(); if (result.Mode != "draw" && result.Mode != "image") throw new ArgumentException(); break;
                    case "shape": result.Shape = item.Value.GetString(); if (!Regex.IsMatch(result.Shape, "^(cross|dot|ring|t)$")) throw new ArgumentException(); break;
                    case "color": result.Color = item.Value.GetString().ToUpperInvariant(); if (!Regex.IsMatch(result.Color, "^#[0-9A-F]{6}$")) throw new ArgumentException(); break;
                    case "size": result.Size = Number(item.Value, 8, 48); break;
                    case "length": result.Length = Number(item.Value, 2, 20); break;
                    case "thickness": result.Thickness = Number(item.Value, 1, 6); break;
                    case "gap": result.Gap = Number(item.Value, 0, 12); break;
                    case "imageSize": result.ImageSize = Number(item.Value, 8, 128); break;
                    case "outline": result.Outline = item.Value.GetBoolean(); break;
                    case "centerDot": result.CenterDot = item.Value.GetBoolean(); break;
                    case "asset":
                        result.Asset = item.Value.ValueType == JsonValueType.Null ? "" : item.Value.GetString();
                        if (result.Asset != "" && !Regex.IsMatch(result.Asset, "^[a-f0-9]{64}\\.(png|gif|jpg)$")) throw new ArgumentException();
                        break;
                    case "assetName":
                        result.AssetName = item.Value.GetString();
                        if (result.AssetName.Length > 120 || Regex.IsMatch(result.AssetName, "[\\x00-\\x1f\\x7f]")) throw new ArgumentException();
                        break;
                    case "id": case "version": case "expiresAt": case "enabled": case "center": break;
                    default: throw new ArgumentException();
                }
            }
            if (result.Mode == "image" && result.Asset == "") throw new ArgumentException();
            return result;
        }
    }
}
