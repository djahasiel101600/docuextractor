from rest_framework import serializers

from .models import ExtractionProfile


class OllamaConnectionTestRequestSerializer(serializers.Serializer):
    baseUrl = serializers.CharField(max_length=500)
    model = serializers.CharField(max_length=200)
    timeoutSeconds = serializers.IntegerField(
        required=False, default=120, min_value=5, max_value=600
    )
    allowCloudModels = serializers.BooleanField(required=False, default=False)


class ExtractionProfileSerializer(serializers.ModelSerializer):
    fields = serializers.JSONField(source="configuration.fields", required=False)
    aiSettings = serializers.JSONField(source="configuration.aiSettings", required=False)
    extractionSettings = serializers.JSONField(
        source="configuration.extractionSettings", required=False
    )
    ocrSettings = serializers.JSONField(source="configuration.ocrSettings", required=False)
    createdAt = serializers.DateTimeField(source="created_at", read_only=True)
    updatedAt = serializers.DateTimeField(source="updated_at", read_only=True)

    class Meta:
        model = ExtractionProfile
        fields = (
            "id",
            "name",
            "description",
            "version",
            "fields",
            "aiSettings",
            "extractionSettings",
            "ocrSettings",
            "createdAt",
            "updatedAt",
        )

    def create(self, validated_data):
        source_configuration = validated_data.pop("configuration", {})
        configuration = {
            "fields": source_configuration.get("fields", []),
            "aiSettings": source_configuration.get(
                "aiSettings",
                {
                    "enabled": False,
                    "baseUrl": "http://127.0.0.1:11434",
                    "model": "",
                    "timeoutSeconds": 120,
                    "contextSize": 16384,
                    "strategy": "review",
                    "allowCloudModels": False,
                },
            ),
            "extractionSettings": source_configuration.get(
                "extractionSettings", {"labelSimilarityThreshold": 0.82}
            ),
            "ocrSettings": source_configuration.get("ocrSettings", {}),
        }
        return ExtractionProfile.objects.create(
            configuration=configuration, **validated_data
        )

    def update(self, instance, validated_data):
        configuration = validated_data.pop("configuration", {})
        if "fields" in configuration:
            instance.configuration["fields"] = configuration["fields"]
        if "aiSettings" in configuration:
            instance.configuration["aiSettings"] = configuration["aiSettings"]
        if "extractionSettings" in configuration:
            instance.configuration["extractionSettings"] = configuration[
                "extractionSettings"
            ]
        if "ocrSettings" in configuration:
            instance.configuration["ocrSettings"] = configuration["ocrSettings"]
        for key, value in validated_data.items():
            setattr(instance, key, value)
        instance.save()
        return instance
