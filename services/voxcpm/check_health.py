#!/usr/bin/env python3
import os
import urllib.error
import urllib.request


DEFAULT_HEALTH_URL = "http://127.0.0.1:8809/health"


def main() -> int:
    health_url = os.environ.get("VOXCPM_HEALTH_URL", DEFAULT_HEALTH_URL).strip()
    api_key = os.environ.get("VOXCPM_API_KEY", "").strip()

    if not api_key:
        print("health check: fail VOXCPM_API_KEY is required for authenticated /health")
        return 2

    unauthenticated = request_status(health_url)
    authenticated = request_status(health_url, bearer_token=api_key)

    print(f"unauthenticated /health: {format_status(unauthenticated)}")
    print(f"authenticated /health: {format_status(authenticated)}")

    passed = unauthenticated == 401 and authenticated == 200
    print(f"health check: {'ok' if passed else 'fail'}")
    return 0 if passed else 1


def request_status(url: str, bearer_token: str | None = None) -> int | str:
    headers = {}
    if bearer_token:
        headers["Authorization"] = "Bearer " + bearer_token

    request = urllib.request.Request(url, headers=headers, method="GET")

    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except Exception as exc:
        return f"{exc.__class__.__name__}: {exc}"


def format_status(status: int | str) -> str:
    if isinstance(status, int):
        return str(status)
    return status.replace(os.path.expanduser("~"), "~")


if __name__ == "__main__":
    raise SystemExit(main())
