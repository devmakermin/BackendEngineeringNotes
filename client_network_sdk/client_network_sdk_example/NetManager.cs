namespace ClientNetworkSdkExample;

public sealed class NetManager
{
    private readonly WebConnect _webConnect;

    // HttpClient의 생성·설정·종료는 호출자가 담당합니다. 요청마다 새로 만들지 않습니다.
    public NetManager(HttpClient httpClient)
    {
        ArgumentNullException.ThrowIfNull(httpClient);
        if (httpClient.BaseAddress is null)
        {
            throw new ArgumentException("BaseAddress must be configured.", nameof(httpClient));
        }
        _webConnect = new WebConnect(httpClient, new ServiceGameData());
    }

    public WebConnect GetWebConnect() => _webConnect;
}
