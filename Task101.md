# Task: Evaluate, Test, and Improve Document Extraction Accuracy Using OCR + Ollama Local LLM

## 1. Objective

I want you to conduct a thorough accuracy assessment of the existing PDF document extraction system and implement improvements to maximize extraction accuracy, consistency, and reliability.

The system currently uses OCR to recognize text from PDF documents. However, conventional OCR has limitations, particularly when interpreting document context, understanding relationships between field labels and values, handling complex layouts, and distinguishing between similar or neighboring information.

To address these limitations, we are now using Ollama with a locally installed AI model to enhance the extraction process.

**Current AI configuration:**

- AI Runtime: Ollama
- Model: `beam:cloud`
- Deployment: Ollama installation on my machine
- Primary purpose: Contextual understanding, intelligent field extraction, and validation of OCR-recognized content.

Your task is to investigate how the existing OCR and Ollama integration works, evaluate its actual extraction accuracy, identify weaknesses, and implement improvements.

The ultimate goal is to make the system extract information as accurately as possible, even when processing documents with complex layouts, inconsistent formatting, and ambiguous field relationships.

## 2. Important: Understand the Existing Architecture First

Before making any modifications, thoroughly inspect the existing implementation.

Determine:

1. Which OCR engine is currently being used.
2. How PDF files are converted into images or processed directly.
3. How OCR-recognized text is collected and organized.
4. How OCR results are passed to Ollama.
5. How the configured model `beam:cloud` is invoked.
6. How Target Field Labels & Aliases are interpreted.
7. How the system associates recognized labels with their corresponding values.
8. How the final extraction results are validated, normalized, and saved.

Identify which responsibilities currently belong to OCR and which belong to the LLM.

Do not assume that the existing implementation is already using Ollama optimally.

Also verify that the configured model name is actually available and that Ollama can successfully invoke it. Do not silently substitute another model if the configured model is unavailable.

## 3. Improve OCR + LLM Collaboration

I want the system to use OCR and the local LLM as complementary technologies.

### Stage 1: OCR Recognition

OCR should remain responsible for:

- Recognizing text from scanned PDF documents.
- Extracting embedded text from digitally generated PDFs where appropriate.
- Preserving page information.
- Capturing text positions and bounding boxes whenever available.
- Identifying text blocks, lines, and document structures where supported.

Avoid unnecessarily sending poorly organized OCR output to the LLM.

### Stage 2: Contextual Understanding Using Ollama

Use the configured Ollama model to improve the interpretation of OCR results.

The LLM should be able to:

- Understand the meaning of document field labels.
- Interpret the relationship between labels and their corresponding values.
- Understand different document layouts.
- Distinguish between neighboring fields.
- Interpret information distributed across multiple columns or tables.
- Handle labels and values that appear on different lines.
- Understand multiline addresses and other multiline fields.
- Distinguish similar fields based on their context.
- Identify relevant information even when the document uses different terminology.
- Recognize when a field is blank or when the available information is insufficient.

The LLM must use the actual document content as its source of information.

It must never invent, assume, or fabricate missing values.

### Stage 3: Accurate Field Association

This is particularly important.

The system must not simply associate a target field with the next recognized text element.

For example, consider a W-8BEN form:

| Field label                                    | Corresponding value           |
| ---------------------------------------------- | ----------------------------- |
| Name of individual who is the beneficial owner | Lawrence Macale               |
| Country of citizenship                         | Philippines                   |
| Permanent residence address                    | 135 Ma Martha St. Dona Carmen |
| City or town, state or province                | Quezon City, Metro Manila     |
| Country of residence                           | Philippines                   |
| Date of birth                                  | 11/04/1998                    |

The LLM should understand these relationships even when multiple fields appear beside one another.

Use OCR spatial information, document layout, and contextual understanding together.

Do not rely exclusively on:

- Sequential OCR reading order.
- Text proximity.
- Regular expressions.
- The first matching text element.
- Hardcoded document coordinates.

The extraction logic should be adaptive to different document layouts.

## 4. Improve Extraction Prompts and Structured Output

Review and optimize the prompts currently being sent to Ollama.

Ensure that prompts clearly communicate:

- The document's recognized content.
- The target fields that need to be extracted.
- The configured field labels and aliases.
- The expected relationship between labels and values.
- The importance of neighboring field boundaries.
- The expected output structure.
- The requirement to preserve actual document values.
- The handling of missing, blank, or ambiguous fields.

Require structured JSON output that follows the application's existing extraction response schema.

The model must:

- Return only the requested fields.
- Avoid including explanations inside extracted values.
- Preserve original information unless normalization is requested.
- Return empty or unresolved values when information cannot be reliably identified.
- Never substitute another field's label or value.

If the existing architecture supports confidence scores, evaluate whether field-level confidence and extraction evidence can be incorporated.

Do not introduce unnecessary output fields that could break existing frontend or backend integrations.

## 5. Accuracy Testing and Evaluation

I want you to perform actual extraction tests, not just inspect the implementation.

Use the existing application's browser interface to test the complete extraction workflow.

### Testing requirements

1. Open the running application using the available browser.
2. Navigate to the document extraction functionality.
3. Use representative PDF documents for testing.
4. Configure or verify the target field labels and aliases.
5. Execute extraction using the currently configured Ollama model.
6. Inspect the actual extracted results.
7. Compare the extracted values against the original PDF contents.
8. Identify incorrect, incomplete, missing, or misassociated values.
9. Investigate the cause of each extraction error.
10. Implement improvements and repeat the tests.

If the application requires authentication, use an existing authorized test session. Do not bypass authentication or modify production data.

### Test different document characteristics

Include:

- Digitally generated PDFs.
- Scanned PDFs.
- Single-page documents.
- Multi-page documents.
- Documents with multiple columns.
- Documents containing tables.
- Documents with multiline values.
- Documents with inconsistent formatting.
- Documents with similar or repeated field labels.
- Documents with handwritten or poorly recognized content, if supported.

Do not optimize the implementation solely for the W-8BEN sample.

The goal is to improve extraction across different document types.

## 6. Evaluate and Improve Ollama Configuration

Investigate whether the current Ollama integration is configured appropriately.

Evaluate:

- Model availability and actual model identity.
- Request configuration.
- Context window requirements.
- Temperature and generation parameters.
- Structured JSON output support.
- Response parsing and validation.
- Request timeouts.
- Error handling.
- Model initialization and repeated loading.
- Processing performance.

Use deterministic or low-variance generation settings where appropriate for structured document extraction.

Do not change the configured model without first evaluating the existing model.

If `beam:cloud` has limitations or is not actually running locally despite the local Ollama installation, clearly explain the findings before recommending an alternative.

Do not introduce external AI services or API dependencies.

## 7. Optimize Accuracy Without Unnecessarily Sacrificing Performance

Accuracy is the primary objective, but processing efficiency must also be considered.

Investigate opportunities to:

- Avoid sending unnecessary OCR content to Ollama.
- Organize OCR text into meaningful sections.
- Include spatial information when it helps resolve field relationships.
- Avoid redundant LLM requests.
- Extract multiple related fields in an efficient structured request.
- Reuse OCR results where possible.
- Avoid repeatedly processing identical document content.
- Use appropriate context sizes.
- Prevent excessive retries and unnecessary model invocations.

Do not arbitrarily reduce document context or remove important spatial information simply to reduce processing time.

Measure the effect of optimizations on both accuracy and processing speed.

## 8. Accuracy Metrics and Reporting

Establish a measurable way to evaluate extraction accuracy.

For each test document, compare the extracted values against manually verified reference values.

Evaluate:

- Correct field identification.
- Correct value extraction.
- Correct label-to-value association.
- Completeness of extracted fields.
- Incorrect or fabricated values.
- Date and address normalization.
- Handling of blank fields.
- Consistency across repeated executions.

Where practical, report:

- Exact field match accuracy.
- Field completeness rate.
- Incorrect extraction rate.
- Missing field rate.
- Document-level extraction success rate.
- Average processing time per document.

Distinguish between OCR recognition errors and LLM interpretation or association errors. This will help identify which component needs improvement.

## 9. Implementation Guidelines

- Preserve the existing application architecture wherever practical.
- Do not unnecessarily rewrite working components.
- Do not introduce additional AI providers.
- Use the existing Ollama integration.
- Maintain compatibility with the existing Target Field Labels & Aliases configuration.
- Preserve existing extraction history, batch processing, and progress tracking.
- Maintain compatibility with existing API response structures.
- Keep the implementation modular and maintainable.
- Add appropriate automated tests for identified extraction failures.
- Do not hardcode solutions specifically for one document template.

## 10. Expected Deliverables

After completing the investigation, testing, and improvements, provide:

1. A summary of the existing OCR and Ollama extraction architecture.
2. Identified weaknesses and their root causes.
3. Improvements made to OCR and LLM collaboration.
4. Changes made to extraction prompts and structured output handling.
5. Changes made to label-to-value association.
6. Ollama configuration findings.
7. Actual browser testing results.
8. Before-and-after extraction accuracy measurements, where reference data is available.
9. Processing performance comparisons.
10. Remaining limitations and recommendations.

## Final Objective

I want to transform the existing OCR-based PDF extraction system into a reliable document intelligence and extraction system using conventional OCR combined with Ollama's local LLM capabilities.

OCR should recognize the document content, while the LLM should help understand the document's meaning, context, and relationships between fields.

The system must prioritize:

**Extraction Accuracy → Data Reliability → Contextual Understanding → Processing Efficiency.**

Do not simply modify prompts and assume the problem is solved.

Inspect the implementation, execute actual tests through the browser, identify extraction errors, investigate their causes, implement improvements, and verify that the results are measurably better.

Continue testing until the identified issues are addressed or clearly documented as remaining limitations.
