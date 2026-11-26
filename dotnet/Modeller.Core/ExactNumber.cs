using System.Globalization;
using System.Numerics;
using System.Text.RegularExpressions;

namespace Modeller.Core;

/** Decimal rules reject precision loss instead of silently rounding clinical values. */
public static class ExactNumber
{
    private static readonly BigInteger Maximum = (BigInteger.One << 96) - 1;
    public static decimal Parse(string text) {
        if (text.Length > 128 || !Regex.IsMatch(text, "^[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?$", RegexOptions.CultureInvariant)) throw new ProcessingException("RECORD_NUMBER");
        var exponentAt = text.IndexOfAny(['e', 'E']);
        var exponent = exponentAt < 0 ? 0 : int.TryParse(text[(exponentAt + 1)..], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var parsed) ? parsed : 1000;
        if (Math.Abs((long)exponent) > 128) throw new ProcessingException("RECORD_NUMBER_PRECISION");
        var mantissa = exponentAt < 0 ? text : text[..exponentAt]; var point = mantissa.IndexOf('.');
        var scale = (point < 0 ? 0 : mantissa.Length - point - 1) - exponent;
        var coefficient = BigInteger.Parse(mantissa.Replace(".", ""), CultureInfo.InvariantCulture);
        if (scale < 0) { coefficient *= BigInteger.Pow(10, -scale); scale = 0; }
        return From(coefficient, scale);
    }
    private static (BigInteger Coefficient, int Scale) Parts(decimal value) {
        var bits = decimal.GetBits(value); var coefficient = ((BigInteger)(uint)bits[2] << 64) | ((BigInteger)(uint)bits[1] << 32) | (uint)bits[0];
        return ((bits[3] & int.MinValue) == 0 ? coefficient : -coefficient, (bits[3] >> 16) & 0xff);
    }
    private static decimal From(BigInteger value, int scale) {
        while (scale > 0 && value % 10 == 0) { value /= 10; scale--; }
        var negative = value.Sign < 0; var absolute = BigInteger.Abs(value);
        if (scale > 28 || absolute > Maximum) throw new ProcessingException("RECORD_NUMBER_PRECISION");
        return new decimal((int)(uint)(absolute & uint.MaxValue), (int)(uint)((absolute >> 32) & uint.MaxValue), (int)(uint)((absolute >> 64) & uint.MaxValue), negative, (byte)scale);
    }
    public static decimal Convert(decimal value, decimal factor, decimal offset) {
        var a = Parts(value); var b = Parts(factor); var c = Parts(offset);
        var scale = Math.Max(a.Scale + b.Scale, c.Scale);
        var coefficient = a.Coefficient * b.Coefficient * BigInteger.Pow(10, scale - a.Scale - b.Scale) + c.Coefficient * BigInteger.Pow(10, scale - c.Scale);
        return From(coefficient, scale);
    }
}
