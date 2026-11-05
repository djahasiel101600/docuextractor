from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("extraction", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="pdfdocument",
            name="processing_duration_ms",
            field=models.PositiveBigIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="pdfdocument",
            name="processing_metrics",
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
