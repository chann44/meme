//
//  APIService.swift
//  meme
//
//  Created by Prathamesh Karambelkar on 11/05/26.
//

import Foundation

struct PicsumImage: Codable {
    let download_url: String
}

class APIService {

    static let shared = APIService()

    func generateImages() async throws -> [String] {

        let url = URL(
            string: "https://picsum.photos/v2/list?page=1&limit=5"
        )!

        let (data, _) = try await URLSession.shared.data(from: url)

        let images = try JSONDecoder().decode(
            [PicsumImage].self,
            from: data
        )

        return images.map { $0.download_url }
    }
}
