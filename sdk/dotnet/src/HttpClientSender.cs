using System.Net.Http.Headers;
using System.Text;

namespace OmniSwitch.Sdk;

/// <summary>Default <see cref="IHttpSender"/> — <see cref="System.Net.Http.HttpClient"/>, no external HTTP dependency.</summary>
public class HttpClientSender : IHttpSender
{
    private static readonly HttpClient SharedClient = new();

    public async Task<HttpResult> SendAsync(
        string method, string url, IDictionary<string, string> headers, string? body, int timeoutMs)
    {
        using var request = new HttpRequestMessage(new HttpMethod(method), url);
        if (body != null)
        {
            request.Content = new StringContent(body, Encoding.UTF8);
            request.Content.Headers.ContentType = null; // set explicitly below, matching header casing callers pass
        }

        foreach (var (key, value) in headers)
        {
            if (key.Equals("Content-Type", StringComparison.OrdinalIgnoreCase))
            {
                request.Content ??= new StringContent(string.Empty);
                request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(value);
            }
            else
            {
                request.Headers.TryAddWithoutValidation(key, value);
            }
        }

        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(timeoutMs));
        using var response = await SharedClient.SendAsync(request, cts.Token);
        var responseBody = await response.Content.ReadAsStringAsync(cts.Token);
        return new HttpResult((int)response.StatusCode, responseBody);
    }
}
