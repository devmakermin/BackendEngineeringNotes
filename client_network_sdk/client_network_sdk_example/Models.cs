namespace ClientNetworkSdkExample;

public static class PacketIds
{
    // 설명용 번호이며 원본 서버의 패킷 계약과 호환되지 않습니다.
    public const int AccountInfo = 1001;
}

public sealed record RequestAccountInfo;

public sealed record ResponseAccountInfo
{
    public required string Nickname { get; init; }
    public required int Level { get; init; }
    public required long Gold { get; init; }
}

internal sealed record RequestPacket<T>(int PacketId, T Data);

internal sealed record ResponsePacket<T>
{
    public required int PacketId { get; init; }
    public required int Code { get; init; }
    public T? Data { get; init; }
}

public enum NetworkError
{
    None, Http, Api, InvalidResponse, Connection, Timeout, Cancelled
}

public sealed record NetworkResult<T>(T? Data, NetworkError Error, int? Code = null)
    where T : class
{
    public bool IsSuccess => Error == NetworkError.None && Data is not null;

    public static NetworkResult<T> Success(T data) => new(data, NetworkError.None);
    public static NetworkResult<T> Failure(NetworkError error, int? code = null) =>
        new(null, error, code);
}
