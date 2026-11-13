using System.Net.Http.Json;
using System.Text.Json;

namespace ClientNetworkSdkExample;

public sealed class WebConnect
{
    // Web 기본값의 숫자 문자열 허용을 사용하지 않고 예제 계약의 JSON 숫자를 요구합니다.
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };
    private readonly HttpClient _http;
    private readonly ServiceGameData _gameData;

    internal WebConnect(HttpClient http, ServiceGameData gameData)
    {
        _http = http;
        _gameData = gameData;
    }

    public ResponseAccountInfo? GetAccountInfo =>
        _gameData.Get<ResponseAccountInfo>(PacketIds.AccountInfo);

    public async Task<NetworkResult<ResponseAccountInfo>> AccountInfoAsync(
        CancellationToken cancellationToken = default)
    {
        try
        {
            var request = new RequestPacket<RequestAccountInfo>(
                PacketIds.AccountInfo, new RequestAccountInfo());
            using var response = await _http.PostAsJsonAsync(
                "api", request, JsonOptions, cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                return NetworkResult<ResponseAccountInfo>.Failure(
                    NetworkError.Http, (int)response.StatusCode);
            }

            // 먼저 공통 필드만 해석합니다. 오류 응답의 data는 계정 모델이 아닐 수 있습니다.
            ResponsePacket<JsonElement>? packet;
            try
            {
                packet = await response.Content.ReadFromJsonAsync<ResponsePacket<JsonElement>>(
                    JsonOptions, cancellationToken);
            }
            catch (InvalidOperationException exception) when (exception.InnerException is ArgumentException)
            {
                // ReadFromJsonAsync가 지원하지 않는 charset을 만난 경우만 처리합니다.
                return NetworkResult<ResponseAccountInfo>.Failure(NetworkError.InvalidResponse);
            }
            if (packet is null || packet.PacketId != PacketIds.AccountInfo)
            {
                return NetworkResult<ResponseAccountInfo>.Failure(NetworkError.InvalidResponse);
            }
            if (packet.Code != 0)
            {
                return NetworkResult<ResponseAccountInfo>.Failure(NetworkError.Api, packet.Code);
            }

            if (packet.Data.ValueKind != JsonValueKind.Object)
            {
                return NetworkResult<ResponseAccountInfo>.Failure(NetworkError.InvalidResponse);
            }
            var account = packet.Data.Deserialize<ResponseAccountInfo>(JsonOptions);
            if (account is null || string.IsNullOrWhiteSpace(account.Nickname)
                || account.Level < 1 || account.Gold < 0)
            {
                return NetworkResult<ResponseAccountInfo>.Failure(NetworkError.InvalidResponse);
            }

            cancellationToken.ThrowIfCancellationRequested();
            _gameData.Save(PacketIds.AccountInfo, account);
            // 공유 콜백 필드 대신 이 요청의 응답을 직접 반환합니다.
            return NetworkResult<ResponseAccountInfo>.Success(account);
        }
        catch (OperationCanceledException)
        {
            return NetworkResult<ResponseAccountInfo>.Failure(
                cancellationToken.IsCancellationRequested ? NetworkError.Cancelled : NetworkError.Timeout);
        }
        catch (HttpRequestException)
        {
            return NetworkResult<ResponseAccountInfo>.Failure(NetworkError.Connection);
        }
        catch (JsonException)
        {
            return NetworkResult<ResponseAccountInfo>.Failure(NetworkError.InvalidResponse);
        }
    }
}
