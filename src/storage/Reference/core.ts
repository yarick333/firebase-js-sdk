/**
* Copyright 2017 Google Inc.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

/**
 * Static Code Dependencies
 */
import { child, lastComponent, parent } from '../implementation/path';
import { invalidRootOperation, noDownloadURL } from '../implementation/error';
import {
  dataFromString,
  formatValidator,
  StringFormat
} from '../implementation/string';
import { Location } from '../implementation/location';
import { Mappings, getMappings } from '../implementation/metadata';
import { Metadata } from '../metadata';
import {
  validate,
  stringSpec,
  uploadDataSpec,
  metadataSpec
} from '../implementation/args';
import { UploadTask } from '../UploadTask/core';
import { FbsBlob } from '../implementation/blob';
import { clone } from '../implementation/object';

/**
 * Provides methods to interact with a bucket in the Firebase Storage service.
 * @param location An fbs.location, or the URL at
 *     which to base this object, in one of the following forms:
 *         gs://<bucket>/<object-path>
 *         http[s]://firebasestorage.googleapis.com/
 *                     <api-version>/b/<bucket>/o/<object-path>
 *     Any query or fragment strings will be ignored in the http[s]
 *     format. If no value is passed, the storage object will use a URL based on
 *     the project ID of the base firebase.App instance.
 */
export class Reference {
  public location: Location;

  constructor(public authWrapper, location: Location | string) {
    this.location =
      location instanceof Location ? location : Location.makeFromUrl(location);
  }

  /**
   * Private Methods
   */
  _throwIfRoot(name: string) {
    if (this.location.path === '') {
      throw invalidRootOperation(name);
    }
  }

  /**
   * Setters and Getters
   */

  get bucket(): string {
    return this.location.bucket;
  }

  get fullPath(): string {
    return this.location.path;
  }

  get name(): string {
    return lastComponent(this.location.path);
  }

  /**
   * @return A reference to the parent of the
   *     current object, or null if the current object is the root.
   */
  get parent(): Reference | null {
    const newPath = parent(this.location.path);
    if (newPath === null) return null;
    const location = new Location(this.location.bucket, newPath);
    return new Reference(this.authWrapper, location);
  }

  /**
   * @return An reference to the root of this
   *     object's bucket.
   */
  get root(): Reference {
    let location = new Location(this.location.bucket, '');
    return new Reference(this.authWrapper, location);
  }

  get storage() {
    return this.authWrapper.service();
  }

  /**
   * @return A reference to the object obtained by
   *     appending childPath, removing any duplicate, beginning, or trailing
   *     slashes.
   */
  child(...args): Reference {
    const [childPath] = args as [string];
    validate('child', [stringSpec()], args);
    const newPath = child(this.location.path, childPath);
    const location = new Location(this.location.bucket, newPath);
    return new Reference(this.authWrapper, location);
  }

  delete(...args) {
    validate('delete', [], args);
    this._throwIfRoot('delete');

    return import('./async').then(() => {
      return this._delete(...args);
    });
  }

  /**
   * @return A promise that resolves with the download
   *     URL for this object.
   */
  getDownloadURL(): Promise<string> {
    validate('getDownloadURL', [], arguments);
    this._throwIfRoot('getDownloadURL');
    return this.getMetadata().then(function(metadata) {
      const [url] = metadata['downloadURLs'] as string[];
      if (!url) throw noDownloadURL();
      return url;
    });
  }

  getMetadata(...args) {
    validate('getMetadata', [], args);
    this._throwIfRoot('getMetadata');

    return import('./async').then(() => {
      return this._getMetadata(...args);
    });
  }

  /**
   * Uploads a blob to this object's location.
   * @param data The blob to upload.
   * @return An UploadTask that lets you control and
   *     observe the upload.
   */
  put(...args) {
    const [data, metadata = null] = args as [
      Blob | Uint8Array | ArrayBuffer,
      Metadata | null
    ];
    validate('put', [uploadDataSpec(), metadataSpec(true)], args);
    this._throwIfRoot('put');

    return new UploadTask(
      this,
      this.authWrapper,
      this.location,
      getMappings(),
      new FbsBlob(data),
      metadata
    );
  }

  /**
   * Uploads a string to this object's location.
   * @param string The string to upload.
   * @param opt_format The format of the string to upload.
   * @return An UploadTask that lets you control and
   *     observe the upload.
   */
  putString(...args) {
    const [string, format = StringFormat.RAW, opt_metadata] = args as [
      string,
      StringFormat,
      Metadata
    ];
    validate(
      'putString',
      [stringSpec(), stringSpec(formatValidator, true), metadataSpec(true)],
      args
    );
    this._throwIfRoot('putString');

    const data = dataFromString(format, string);
    const metadata = clone<Metadata>(opt_metadata);

    if (!metadata['contentType'] && data.contentType) {
      metadata['contentType'] = data.contentType;
    }

    return new UploadTask(
      this,
      this.authWrapper,
      this.location,
      getMappings(),
      new FbsBlob(data.data, true),
      metadata
    );
  }

  /**
   * @return The URL for the bucket and path this object references,
   * in the form gs://<bucket>/<object-path>
   */
  toString(...args): string {
    validate('toString', [], args);
    return 'gs://' + this.location.bucket + '/' + this.location.path;
  }

  /**
   * Updates the metadata for this object.
   * @param metadata The new metadata for the object.
   *     Only values that have been explicitly set will be changed. Explicitly
   *     setting a value to null will remove the metadata.
   * @return A promise that resolves
   *     with the new metadata for this object.
   *     @see firebaseStorage.Reference.prototype.getMetadata
   */
  updateMetadata(...args): Promise<Metadata> {
    const [metadata] = args as [Metadata];
    validate('updateMetadata', [metadataSpec()], args);
    this._throwIfRoot('updateMetadata');

    return import('./async').then(() => {
      return this._updateMetadata(...args);
    });
  }
}
