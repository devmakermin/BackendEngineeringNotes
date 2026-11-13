using System.Text;
using ClientNetworkSdkExample;

Console.OutputEncoding = Encoding.UTF8;

if (args is ["--verify"])
{
    await Verification.RunAsync();
    return;
}
if (args.Length != 0)
{
    Console.Error.WriteLine("Usage: dotnet run [-- --verify]");
    Environment.ExitCode = 1;
    return;
}

await using var server = await DemoServer.StartAsync();
try
{
    using var http = new HttpClient
    {
        BaseAddress = new Uri(server.Urls.Single()),
        Timeout = TimeSpan.FromSeconds(5),
        MaxResponseContentBufferSize = 64 * 1024
    };
    var web = new NetManager(http).GetWebConnect();
    Console.WriteLine($"조회 전 캐시: {(web.GetAccountInfo is null ? "없음" : "있음")}");

    var result = await web.AccountInfoAsync();
    if (result.IsSuccess && result.Data is { } account)
    {
        Console.WriteLine($"응답: {account.Nickname}, Lv.{account.Level}, Gold={account.Gold}");
        var cached = web.GetAccountInfo!;
        Console.WriteLine($"캐시: {cached.Nickname}, Lv.{cached.Level}, Gold={cached.Gold}");
    }
    else
    {
        Console.Error.WriteLine($"요청 실패: {result.Error}, Code={result.Code}");
        Environment.ExitCode = 1;
    }
}
finally
{
    await server.StopAsync();
}
