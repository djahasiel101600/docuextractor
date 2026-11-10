from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('extraction', '0004_pdfdocument_assignment_confidence_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='processingjob',
            name='skipped_count',
            field=models.PositiveIntegerField(default=0),
        ),
        migrations.AlterField(
            model_name='pdfdocument',
            name='processing_status',
            field=models.CharField(choices=[('pending', 'Pending'), ('processing', 'Processing'), ('completed', 'Completed'), (
                'failed', 'Failed'), ('excluded', 'Excluded by user')], default='pending', max_length=20),
        ),
    ]
