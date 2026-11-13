using System.Text.Json;

namespace ClientNetworkSdkExample;

// 원본의 패킷 ID → JSON 저장 방식만 남겼습니다. 외부에는 Dictionary를 노출하지 않습니다.
internal sealed class ServiceGameData
{
    private readonly Dictionary<int, string> _responses = new();
    private readonly object _sync = new();

    public void Save<T>(int packetId, T data)
    {
        var json = JsonSerializer.Serialize(data);
        lock (_sync)
        {
            _responses[packetId] = json;
        }
    }

    public T? Get<T>(int packetId) where T : class
    {
        string? json;
        lock (_sync)
        {
            _responses.TryGetValue(packetId, out json);
        }
        return json is null ? null : JsonSerializer.Deserialize<T>(json);
    }
}
