namespace ClientNetworkSdkExample;

// SDK에 포함할 서버가 아니라, 예제를 혼자 실행하기 위한 고정 응답 서버입니다.
internal static class DemoServer
{
    public static async Task<WebApplication> StartAsync()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var app = builder.Build();

        app.MapPost("/api", (RequestPacket<RequestAccountInfo> request) =>
        {
            var supported = request.PacketId == PacketIds.AccountInfo;
            return Results.Json(new ResponsePacket<ResponseAccountInfo>
            {
                PacketId = request.PacketId,
                Code = supported ? 0 : 4001,
                Data = supported ? new ResponseAccountInfo
                {
                    Nickname = "DemoPlayer", Level = 12, Gold = 3500
                } : null
            });
        });

        await app.StartAsync();
        return app;
    }
}
