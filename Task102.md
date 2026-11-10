# Task: Analyze and Improve DocuExtract's Batch Processing Workflow for Multiple Document Types and Extraction Profiles

I want you to thoroughly understand DocuExtract's existing architecture and end-to-end workflow, from the moment a user uploads documents until extraction results are generated and reviewed.

**Before proposing or implementing any changes, inspect the existing codebase, understand the current processing pipeline, identify the relevant components, and determine how the existing Extraction Profile mechanism works.** Do not make assumptions about the implementation.

## 1. Understand the Current System Workflow

Assume the user has already created the necessary Extraction Profiles.

The current workflow is as follows:

1. **Upload Documents**
   - The user uploads one or more ZIP files containing PDF documents.
   - The system extracts and registers the uploaded files for processing.

2. **Processing Insights**
   - After uploading, the system provides an overview of the uploaded documents.
   - This includes Processing Insights and Unsupported Files.
   - The user can search and filter the uploaded file list to inspect specific documents.
   - However, these search and filter options currently serve as viewing tools only. When processing starts, the system processes all eligible files in the batch, regardless of the currently applied search or filter.

3. **Extraction Profile Selection**
   - The user selects an Extraction Profile to be applied to the batch.
   - Currently, the system only allows one Extraction Profile to be selected per batch upload.
   - Consequently, the selected profile is applied to all eligible documents in that batch.

4. **Processing and Results**
   - The system processes the documents using the selected Extraction Profile.
   - Once processing is completed, the user can review the extracted information.
   - The user can manually correct extracted values that do not match the expected results.

## 2. The Problem: Multiple Document Types in One Batch

Consider the following scenario:

A user uploads a ZIP file containing three different types of PDF forms:

- F-1
- F-2
- F-3

The user has already created three corresponding Extraction Profiles:

- Extraction Profile F-1
- Extraction Profile F-2
- Extraction Profile F-3

However, because the current system only supports one Extraction Profile per batch, the user must select only one profile.

For example, if the user selects Extraction Profile F-1:

- F-1 documents will be processed using their intended extraction configuration.
- F-2 and F-3 documents will also be processed using Extraction Profile F-1, even though they have different document structures and extraction requirements.
- As a result, F-2 and F-3 may produce inaccurate, incomplete, or irrelevant extraction results.

To process the remaining document types correctly, the user must:

1. Upload the same ZIP file again.
2. Select Extraction Profile F-2.
3. Process the entire batch again.
4. Repeat the process using Extraction Profile F-3.

This creates several problems:

- Repeated uploading of identical documents.
- Unnecessary processing of documents that do not belong to the selected profile.
- Wasted CPU, memory, OCR, and Ollama processing resources.
- Increased processing time.
- Duplicate batches and potentially duplicated storage.
- Poor user experience, especially when dealing with hundreds or thousands of documents.

**I want to eliminate this unnecessary workflow.**

## 3. Proposed Direction: Intelligent Document Grouping and Extraction Profile Assignment

I want you to investigate and propose a solution that allows the system to identify different document types within a single batch and assign the appropriate Extraction Profile to each document before extraction begins.

One important observation is that the documents may have identifiable filename patterns.

For example:

| Document Type | Example Filename     | Extraction Profile     |
| ------------- | -------------------- | ---------------------- |
| F-1           | `REQUEST_001_F1.pdf` | Extraction Profile F-1 |
| F-1           | `REQUEST_002_F1.pdf` | Extraction Profile F-1 |
| F-2           | `REQUEST_001_F2.pdf` | Extraction Profile F-2 |
| F-2           | `REQUEST_002_F2.pdf` | Extraction Profile F-2 |
| F-3           | `REQUEST_001_F3.pdf` | Extraction Profile F-3 |
| F-3           | `REQUEST_002_F3.pdf` | Extraction Profile F-3 |

Since filenames may contain consistent prefixes or suffixes, I want you to explore whether filename-based identification can be used to automatically group documents and associate them with their corresponding Extraction Profiles.

However, **do not assume that filename matching should be the only identification mechanism.** Consider other possible approaches, such as:

- Filename prefix and suffix matching.
- Configurable regular expressions.
- Existing document classification capabilities.
- PDF metadata or document characteristics.
- Embedded text and identifiable document labels.
- Other lightweight identification methods that can avoid unnecessary OCR or LLM processing.

The solution should prioritize reliable, inexpensive identification methods before considering more resource-intensive techniques.

## 4. Expected User Experience

Explore a workflow similar to the following:

### Step 1 – Upload

The user uploads one or more ZIP files containing different document types.

### Step 2 – Analyze Uploaded Files

The system analyzes the uploaded files and provides the existing Processing Insights and Unsupported Files information.

Additionally, the system identifies potential document groups based on their filenames or other available identification information.

### Step 3 – Document Grouping and Profile Assignment

The system presents the identified document groups and allows the user to assign an Extraction Profile to each group.

For example:

| Document Group | Identified Files | Assigned Extraction Profile | Status       |
| -------------- | ---------------: | --------------------------- | ------------ |
| F-1            |              150 | Extraction Profile F-1      | Assigned     |
| F-2            |               85 | Extraction Profile F-2      | Assigned     |
| F-3            |              120 | Extraction Profile F-3      | Assigned     |
| Unidentified   |               12 | None                        | Needs Review |

The user should be able to:

- Review the identified groups.
- See how many files belong to each group.
- Assign or change an Extraction Profile.
- Manually move files between groups when necessary.
- Inspect files that could not be confidently identified.
- Exclude files from processing when appropriate.

The system should also consider automatically assigning profiles when an existing identification rule produces an unambiguous match.

### Step 4 – Processing

Once the user confirms the assignments, the system should process each document using its corresponding Extraction Profile.

For example:

- All F-1 documents use Extraction Profile F-1.
- All F-2 documents use Extraction Profile F-2.
- All F-3 documents use Extraction Profile F-3.

Documents without an assigned profile should not silently be processed using an unrelated profile.

The system should clearly identify these documents and allow the user to decide how to handle them.

### Step 5 – Results and Review

After processing, the system should present the results in a unified batch.

The user should still be able to review and correct extracted values using the existing result-review functionality.

The user should also be able to identify which Extraction Profile was used for each processed document.

## 5. Important Technical and Architectural Considerations

When evaluating the solution, consider the following requirements:

**A. Avoid unnecessary processing**

Document identification and profile assignment should happen before expensive extraction operations whenever possible.

For example, do not run OCR or Ollama on every document simply to determine which Extraction Profile should be used if filename patterns or lightweight PDF analysis can identify it.

**B. Preserve the existing extraction architecture**

DocuExtract already has an extraction pipeline involving:

- Native PDF text extraction.
- PDF structural analysis.
- Fillable field detection.
- Tesseract OCR.
- Conventional field matching.
- Ollama-assisted extraction and validation.

Do not unnecessarily replace or duplicate these components. Integrate the proposed solution into the existing architecture.

**C. Preserve existing functionality**

Existing capabilities such as ZIP uploads, Processing Insights, Unsupported Files, file filtering, Extraction Profiles, extraction processing, diagnostics, and result review must continue working.

**D. Handle ambiguous identification**

Consider cases where:

- A filename matches multiple identification rules.
- A filename does not match any rule.
- Two document groups have overlapping patterns.
- A document is incorrectly identified.
- An Extraction Profile is deleted or becomes unavailable.
- A document type is identified but has no assigned Extraction Profile.

The system should not silently assign an arbitrary profile in these situations.

**E. Maintain traceability**

The system should maintain the relationship between:

- Original uploaded file.
- Identified document type or group.
- Identification method and matching rule.
- Assigned Extraction Profile.
- Extraction execution.
- Final extraction results.

This is important for troubleshooting, diagnostics, and auditing.

**F. Support multiple ZIP uploads**

The solution should work whether the user uploads one ZIP file or multiple ZIP files containing different document types.

Avoid designing something that only works for a single ZIP upload.

## 6. What I Want You to Do First

At this stage, I want you to focus on understanding and evaluating the existing system before immediately modifying the code.

Please perform the following:

1. Trace the complete current upload-to-results workflow.
2. Identify the frontend components, backend endpoints, services, models, tasks, and database relationships involved.
3. Determine exactly how Extraction Profiles are currently selected and passed to the processing pipeline.
4. Identify where document grouping and profile assignment could be introduced with minimal disruption.
5. Evaluate the feasibility of filename-based identification, particularly prefix, suffix, and regex matching.
6. Propose an appropriate design for storing identification rules and mapping them to Extraction Profiles.
7. Identify potential performance implications, edge cases, and migration requirements.

## 7. Expected Deliverable

Before implementing anything, provide a technical assessment containing:

1. **Current Architecture:** Explanation of the existing upload-to-results workflow, based on the actual codebase.
2. **Problem Analysis:** The exact limitations preventing multiple Extraction Profiles from being used in one batch.
3. **Proposed Solution:** Recommended architecture and workflow for document grouping and Extraction Profile assignment.
4. **UI/UX Recommendations:** How users should interact with identified document groups and profile assignments.
5. **Backend Changes:** Required models, services, APIs, processing logic, and database changes, if any.
6. **Performance Considerations:** How to minimize unnecessary PDF, OCR, and Ollama processing.
7. **Implementation Plan:** A logical sequence of changes that minimizes regression risks.
8. **Potential Risks:** Edge cases and compatibility concerns.

If there are multiple viable approaches, compare them and recommend the most appropriate one based on DocuExtract's existing architecture.

**Important instructions:**

- Do not immediately start implementing changes.
- Do not invent existing functionality or assume how components work. Verify everything against the codebase.
- Do not introduce unnecessary abstractions or duplicate existing services.
- Prioritize backward compatibility and maintainability.
- Clearly distinguish existing functionality from proposed functionality.
- If you identify an existing implementation that can already support part of this requirement, explain how it can be extended rather than rebuilt.

The ultimate goal is to allow users to upload mixed-document batches once, intelligently group the documents, assign the correct Extraction Profiles, and process everything efficiently within a single batch-processing workflow.
