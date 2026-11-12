from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('extraction', '0006_processingjob_cancel_requested_and_more'),
    ]

    operations = [
        migrations.AlterField(
            model_name='pdfdocument',
            name='processing_status',
            field=models.CharField(choices=[('pending', 'Pending'), ('processing', 'Processing'), ('completed', 'Completed'), (
                'failed', 'Failed'), ('excluded', 'Excluded by user'), ('skipped_unassigned', 'Skipped - no profile assigned')], default='pending', max_length=20),
        ),
    ]
