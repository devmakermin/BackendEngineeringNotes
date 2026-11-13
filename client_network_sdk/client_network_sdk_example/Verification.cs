using System.Net;
using System.Text;
using System.Text.Json;

namespace ClientNetworkSdkExample;

// 외부 테스트 패키지 없이 실패·동시 요청 경계를 확인합니다.
internal static class Verification
{
    private const string Success = """{"packetId":1001,"code":0,"data":{"nickname":"DemoPlayer","level":12,"gold":3500}}""";
    private static int _passed;

    public static async Task RunAsync()
    {
        await using (var server = await DemoServer.StartAsync())
        {
            try
            {
                using var http = new HttpClient { BaseAddress = new Uri(server.Urls.Single()) };
                var web = new NetManager(http).GetWebConnect();
                Check(web.GetAccountInfo is null, "캐시는 최초 조회 전 비어 있음");
                var result = await web.AccountInfoAsync();
                Check(result.IsSuccess && result.Data?.Gold == 3500
                    && web.GetAccountInfo == result.Data, "실제 loopback HTTP → 모델 → 캐시");
                Check(new NetManager(http).GetWebConnect().GetAccountInfo is null,
                    "NetManager 인스턴스 사이의 캐시 분리");
            }
            finally
            {
                await server.StopAsync();
            }
        }

        using (var http = Client(async (request, token) =>
        {
            using var json = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            Check(request.Method == HttpMethod.Post && request.RequestUri?.AbsolutePath == "/api"
                && json.RootElement.GetProperty("packetId").GetInt32() == 1001
                && json.RootElement.GetProperty("data").ValueKind == JsonValueKind.Object,
                "POST /api 요청 계약");
            return Reply(Success);
        }))
        {
            Check((await new NetManager(http).GetWebConnect().AccountInfoAsync()).IsSuccess,
                "모의 HTTP 응답 처리");
        }

        (string Name, string Body, HttpStatusCode Status, NetworkError Error, int? Code)[] failures =
        [
            ("HTTP 실패", "unavailable", HttpStatusCode.ServiceUnavailable, NetworkError.Http, 503),
            ("API 실패", """{"packetId":1001,"code":1401,"data":null}""", HttpStatusCode.OK, NetworkError.Api, 1401),
            ("API 실패·오류 객체", """{"packetId":1001,"code":1401,"data":{"message":"Login required"}}""", HttpStatusCode.OK, NetworkError.Api, 1401),
            ("API 실패·오류 문자열", """{"packetId":1001,"code":1401,"data":"Login required"}""", HttpStatusCode.OK, NetworkError.Api, 1401),
            ("API 실패·data 생략", """{"packetId":1001,"code":1401}""", HttpStatusCode.OK, NetworkError.Api, 1401),
            ("잘못된 JSON", "{", HttpStatusCode.OK, NetworkError.InvalidResponse, null),
            ("빈 본문", "", HttpStatusCode.OK, NetworkError.InvalidResponse, null),
            ("null 응답", "null", HttpStatusCode.OK, NetworkError.InvalidResponse, null),
            ("패킷 불일치", Success.Replace("1001", "9999"), HttpStatusCode.OK, NetworkError.InvalidResponse, null),
            ("packetId 누락", Success.Replace("\"packetId\":1001,", ""), HttpStatusCode.OK, NetworkError.InvalidResponse, null),
            ("code 누락", Success.Replace("\"code\":0,", ""), HttpStatusCode.OK, NetworkError.InvalidResponse, null),
            ("data 누락", """{"packetId":1001,"code":0}""", HttpStatusCode.OK, NetworkError.InvalidResponse, null),
            ("성공 응답·문자열 data", """{"packetId":1001,"code":0,"data":"Not an account"}""", HttpStatusCode.OK, NetworkError.InvalidResponse, null),
            ("gold 누락", Success.Replace(",\"gold\":3500", ""), HttpStatusCode.OK, NetworkError.InvalidResponse, null),
            ("숫자 문자열", Success.Replace("3500", "\"3500\""), HttpStatusCode.OK, NetworkError.InvalidResponse, null),
            ("음수 gold", Success.Replace("3500", "-1"), HttpStatusCode.OK, NetworkError.InvalidResponse, null),
            ("null 닉네임", Success.Replace("\"DemoPlayer\"", "null"), HttpStatusCode.OK, NetworkError.InvalidResponse, null)
        ];
        foreach (var test in failures)
        {
            var calls = 0;
            using var http = Client((_, _) => Task.FromResult(
                ++calls == 1 ? Reply(Success) : Reply(test.Body, test.Status)));
            var web = new NetManager(http).GetWebConnect();
            var initial = await web.AccountInfoAsync();
            var result = await web.AccountInfoAsync();
            Check(initial.IsSuccess && !result.IsSuccess && result.Data is null
                && result.Error == test.Error && result.Code == test.Code
                && web.GetAccountInfo == initial.Data,
                $"{test.Name}: 오류 분류 및 기존 캐시 보존");
        }

        foreach (var primeCache in new[] { false, true })
        {
            var calls = 0;
            using var http = Client((_, _) =>
            {
                var response = Reply(Success);
                if (!primeCache || ++calls > 1)
                {
                    response.Content.Headers.ContentType!.CharSet = "invalid-charset";
                }
                return Task.FromResult(response);
            });
            var web = new NetManager(http).GetWebConnect();
            if (primeCache)
            {
                var initial = await web.AccountInfoAsync();
                if (!initial.IsSuccess) throw new InvalidOperationException("Cache setup failed.");
            }
            var previous = web.GetAccountInfo;
            var result = await web.AccountInfoAsync();
            Check(!result.IsSuccess && result.Error == NetworkError.InvalidResponse
                && result.Data is null && web.GetAccountInfo == previous,
                $"지원하지 않는 charset: 예외 대신 오류 반환·캐시 보존 (기존 캐시={primeCache})");
        }

        using (var http = Client((_, _) =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(Success.Replace("DemoPlayer", "테스트유저"),
                    Encoding.Unicode, "application/json")
            };
            response.Content.Headers.ContentType!.CharSet = "\"utf-16\"";
            return Task.FromResult(response);
        }))
        {
            var web = new NetManager(http).GetWebConnect();
            var result = await web.AccountInfoAsync();
            Check(result.IsSuccess && result.Data?.Nickname == "테스트유저"
                && web.GetAccountInfo == result.Data, "지원하는 charset: 따옴표가 있는 UTF-16 한글 응답");
        }

        using (var http = Client((_, _) => throw new HttpRequestException("Simulated connection failure")))
        {
            var web = new NetManager(http).GetWebConnect();
            Check((await web.AccountInfoAsync()).Error == NetworkError.Connection
                && web.GetAccountInfo is null, "연결 실패는 캐시를 만들지 않음");
        }

        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using (var http = Client(async (_, token) =>
        {
            started.SetResult();
            await Task.Delay(Timeout.Infinite, token);
            return Reply(Success);
        }))
        using (var cancellation = new CancellationTokenSource())
        {
            var web = new NetManager(http).GetWebConnect();
            var pending = web.AccountInfoAsync(cancellation.Token);
            await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
            cancellation.Cancel();
            Check((await pending.WaitAsync(TimeSpan.FromSeconds(5))).Error == NetworkError.Cancelled
                && web.GetAccountInfo is null, "진행 중 요청 취소");
        }

        using (var http = Client(async (_, token) =>
        {
            await Task.Delay(Timeout.Infinite, token);
            return Reply(Success);
        }))
        {
            http.Timeout = TimeSpan.FromMilliseconds(100);
            var web = new NetManager(http).GetWebConnect();
            Check((await web.AccountInfoAsync().WaitAsync(TimeSpan.FromSeconds(5))).Error
                == NetworkError.Timeout && web.GetAccountInfo is null, "HttpClient 타임아웃");
        }

        // 첫 요청을 일부러 늦게 완료해 요청별 반환값과 캐시의 완료 순서 정책을 확인합니다.
        var firstStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirst = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var count = 0;
        using (var http = Client(async (_, token) =>
        {
            var number = Interlocked.Increment(ref count);
            if (number == 1)
            {
                firstStarted.SetResult();
                await releaseFirst.Task.WaitAsync(token);
            }
            return Reply(Success.Replace("3500", number == 1 ? "100" : "200"));
        }))
        {
            var web = new NetManager(http).GetWebConnect();
            var first = web.AccountInfoAsync();
            await firstStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var second = await web.AccountInfoAsync();
            releaseFirst.SetResult();
            var firstResult = await first.WaitAsync(TimeSpan.FromSeconds(5));
            Check(firstResult.Data?.Gold == 100 && second.Data?.Gold == 200,
                "동시 요청의 반환값이 섞이지 않음");
            Check(web.GetAccountInfo?.Gold == 100, "캐시는 마지막으로 저장된 성공 응답");
        }

        Console.WriteLine($"PASS: {_passed} checks");
    }

    private static HttpClient Client(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) =>
        new(new StubHandler(send)) { BaseAddress = new Uri("http://localhost/"), Timeout = TimeSpan.FromSeconds(5) };

    private static HttpResponseMessage Reply(string json, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    private static void Check(bool condition, string name)
    {
        if (!condition) throw new InvalidOperationException($"FAIL: {name}");
        _passed++;
        Console.WriteLine($"PASS: {name}");
    }

    private sealed class StubHandler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken) => send(request, cancellationToken);
    }
}
