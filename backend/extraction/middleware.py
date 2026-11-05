from django.conf import settings
from django.http import JsonResponse


class LocalApiOriginMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        origin = request.headers.get("Origin")
        if (
            request.path.startswith("/api/")
            and origin
            and origin not in settings.CORS_ALLOWED_ORIGINS
        ):
            return JsonResponse({"detail": "Requests from this origin are not allowed."}, status=403)
        return self.get_response(request)
